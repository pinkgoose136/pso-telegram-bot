require("dotenv").config();
const fs = require("fs");


// ======================================================
// CONFIG
// ======================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID = String(process.env.TELEGRAM_USER_ID);

const PSO_PERIOD = Number(process.env.PSO_PERIOD || 32);
const PSO_SMOOTH = Number(process.env.PSO_SMOOTH || 5);
const SIGNAL_LEVEL = Number(process.env.SIGNAL_LEVEL || 0.8);

// Как часто технически спрашиваем Binance.
// Сигнал всё равно обрабатывается только один раз
// на каждую новую закрытую 5m свечу.
const CHECK_INTERVAL = Number(
    process.env.CHECK_INTERVAL || 20
) * 1000;

// Публичный Binance market-data API
const BINANCE_API =
    "https://data-api.binance.vision";

const STATE_FILE =
    process.env.STATE_FILE ||
    "./state.json";


// ======================================================
// COINS
// ======================================================

function normalizeCoin(coin) {
    if (!coin) return "";

    let value = String(coin)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");

    if (value.endsWith("USDT")) {
        value = value.slice(0, -4);
    }

    return value;
}

function getSymbol(coin) {
    return `${normalizeCoin(coin)}USDT`;
}


// ======================================================
// STATE
// ======================================================

function defaultState() {
    const coins = (
        process.env.SYMBOLS ||
        "BTC,ETH,SOL"
    )
        .split(",")
        .map(normalizeCoin)
        .filter(Boolean);

    return {
        coins,

        // последнее значение 1H PSO,
        // которое было рассчитано после закрытия 5m свечи
        lastPso: {},

        // последняя обработанная закрытая 5m свеча
        last5mCandle: {},

        // последний ОТПРАВЛЕННЫЙ тип сигнала
        // для каждой монеты:
        //
        // upper = последний был красный
        // lower = последний был зелёный
        //
        // Повторный сигнал того же типа игнорируется,
        // пока не появится противоположный.
        lastSignal: {}
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return defaultState();
        }

        const saved = JSON.parse(
            fs.readFileSync(
                STATE_FILE,
                "utf8"
            )
        );

        return {
            coins:
                Array.isArray(saved.coins) &&
                saved.coins.length
                    ? saved.coins
                        .map(normalizeCoin)
                        .filter(Boolean)
                    : defaultState().coins,

            lastPso:
                saved.lastPso || {},

            last5mCandle:
                saved.last5mCandle || {},

            lastSignal:
                saved.lastSignal || {}
        };

    } catch (err) {
        console.error(
            "Ошибка state.json:",
            err.message
        );

        return defaultState();
    }
}

let state = loadState();

function saveState() {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(
            state,
            null,
            2
        )
    );
}

function getCoins() {
    return state.coins;
}


// ======================================================
// TELEGRAM
// ======================================================

async function telegramRequest(
    method,
    data = {}
) {
    const url =
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    const response =
        await fetch(url, {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json"
            },

            body: JSON.stringify(data)
        });

    const result =
        await response.json();

    if (
        !response.ok ||
        !result.ok
    ) {
        throw new Error(
            `Telegram: ${
                JSON.stringify(result)
            }`
        );
    }

    return result.result;
}

async function sendTelegram(text) {
    return telegramRequest(
        "sendMessage",
        {
            chat_id: USER_ID,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true
        }
    );
}


// ======================================================
// BINANCE 5M
// ======================================================

async function fetch5mBatch(
    symbol,
    endTime = null
) {
    let url =
        `${BINANCE_API}/api/v3/klines` +
        `?symbol=${symbol}` +
        `&interval=5m` +
        `&limit=1000`;

    if (endTime !== null) {
        url +=
            `&endTime=${endTime}`;
    }

    const response =
        await fetch(url);

    if (!response.ok) {
        const body =
            await response.text();

        throw new Error(
            `${symbol}: Binance ` +
            `${response.status}: ${body}`
        );
    }

    return response.json();
}


// Получаем около 3000 свечей 5m.
// Это ~250 часов истории.
//
// Для PSO 32 + double smoothing этого
// более чем достаточно для прогрева.
async function get5mCandles(coin) {
    const symbol =
        getSymbol(coin);

    const all = [];

    let endTime = null;

    for (let page = 0; page < 3; page++) {
        const data =
            await fetch5mBatch(
                symbol,
                endTime
            );

        if (
            !Array.isArray(data) ||
            !data.length
        ) {
            break;
        }

        all.unshift(...data);

        const oldestOpenTime =
            Number(data[0][0]);

        endTime =
            oldestOpenTime - 1;

        if (data.length < 1000) {
            break;
        }
    }

    // удаляем возможные дубликаты
    const map = new Map();

    for (const row of all) {
        map.set(
            Number(row[0]),
            row
        );
    }

    const rows =
        [...map.values()]
            .sort(
                (a, b) =>
                    Number(a[0]) -
                    Number(b[0])
            );

    return rows.map(row => ({
        openTime:
            Number(row[0]),

        open:
            Number(row[1]),

        high:
            Number(row[2]),

        low:
            Number(row[3]),

        close:
            Number(row[4]),

        closeTime:
            Number(row[6])
    }));
}


// ======================================================
// ONLY CLOSED 5M CANDLES
// ======================================================

function removeOpen5mCandle(candles) {
    const now =
        Date.now();

    return candles.filter(
        candle =>
            candle.closeTime < now
    );
}


// ======================================================
// 5M -> 1H AGGREGATION
// ======================================================

function getHourStart(timestamp) {
    const HOUR =
        60 * 60 * 1000;

    return (
        Math.floor(
            timestamp / HOUR
        ) * HOUR
    );
}

function aggregate5mTo1h(
    candles5m
) {
    const hourly = [];

    let currentHour = null;
    let current = null;

    for (
        const candle
        of candles5m
    ) {
        const hourStart =
            getHourStart(
                candle.openTime
            );

        if (
            currentHour === null ||
            hourStart !== currentHour
        ) {
            if (current) {
                hourly.push(current);
            }

            currentHour =
                hourStart;

            current = {
                openTime:
                    hourStart,

                open:
                    candle.open,

                high:
                    candle.high,

                low:
                    candle.low,

                close:
                    candle.close,

                closeTime:
                    candle.closeTime
            };

        } else {
            current.high =
                Math.max(
                    current.high,
                    candle.high
                );

            current.low =
                Math.min(
                    current.low,
                    candle.low
                );

            current.close =
                candle.close;

            current.closeTime =
                candle.closeTime;
        }
    }

    if (current) {
        hourly.push(current);
    }

    return hourly;
}


// ======================================================
// PSO
// ======================================================

function calculatePSO(candles) {
    const alpha =
        2.0 /
        (1.0 + PSO_SMOOTH);

    let ema0 = 0;
    let ema1 = 0;

    const result = [];

    for (
        let i = 0;
        i < candles.length;
        i++
    ) {
        const start =
            Math.max(
                0,
                i - PSO_PERIOD + 1
            );

        let mini =
            Infinity;

        let maxi =
            -Infinity;

        for (
            let j = start;
            j <= i;
            j++
        ) {
            mini =
                Math.min(
                    mini,
                    candles[j].low
                );

            maxi =
                Math.max(
                    maxi,
                    candles[j].high
                );
        }

        const priceSpan =
            maxi - mini;

        const sto =
            priceSpan !== 0
                ? 10.0 * (
                    (
                        candles[i].close -
                        mini
                    ) /
                    priceSpan -
                    0.5
                )
                : 0.0;


        const prevEma0 =
            ema0;

        const prevEma1 =
            ema1;


        ema0 =
            prevEma0 +
            alpha *
            (
                sto -
                prevEma0
            );

        ema1 =
            prevEma1 +
            alpha *
            (
                ema0 -
                prevEma1
            );


        const iexp =
            Math.exp(
                ema1
            );

        const pso =
            (
                iexp - 1.0
            ) /
            (
                iexp + 1.0
            );


        result.push({
            candle:
                candles[i],

            value:
                pso
        });
    }

    return result;
}


// ======================================================
// CURRENT 1H PSO FROM 5M DATA
// ======================================================

async function getCurrentPso(
    coin
) {
    let candles5m =
        await get5mCandles(
            coin
        );

    candles5m =
        removeOpen5mCandle(
            candles5m
        );

    if (
        candles5m.length < 100
    ) {
        throw new Error(
            `${coin}: мало 5m данных`
        );
    }

    const last5m =
        candles5m[
            candles5m.length - 1
        ];

    const hourly =
        aggregate5mTo1h(
            candles5m
        );

    const values =
        calculatePSO(
            hourly
        );

    if (!values.length) {
        throw new Error(
            `${coin}: PSO не рассчитан`
        );
    }

    const current =
        values[
            values.length - 1
        ];

    return {
        value:
            current.value,

        hourOpenTime:
            current.candle.openTime,

        last5mOpenTime:
            last5m.openTime,

        last5mCloseTime:
            last5m.closeTime
    };
}


// ======================================================
// FORMAT
// ======================================================

function formatPSO(value) {
    return Number(value)
        .toFixed(4);
}

function getZone(value) {
    if (
        value >= SIGNAL_LEVEL
    ) {
        return "🔴";
    }

    if (
        value <= -SIGNAL_LEVEL
    ) {
        return "🟢";
    }

    return "⚪";
}


// ======================================================
// REPORT
// ======================================================

async function createReport(title) {
    const lines = [
        `<b>${title}</b>`,
        "",
        `График: <b>5m</b>`,
        `Индикатор: <b>1H PSO</b>`,
        `Граница: <b>±${SIGNAL_LEVEL}</b>`,
        ""
    ];

    for (
        const coin
        of getCoins()
    ) {
        try {
            const data =
                await getCurrentPso(
                    coin
                );

            lines.push(
                `${getZone(data.value)} ` +
                `<b>${coin}</b>: ` +
                `${formatPSO(data.value)}`
            );

        } catch (err) {
            console.error(
                `${coin}:`,
                err.message
            );

            lines.push(
                `❌ <b>${coin}</b>: ошибка`
            );
        }
    }

    return lines.join("\n");
}

async function sendStartupReport() {
    const report =
        await createReport(
            "🚀 PSO Monitor запущен"
        );

    await sendTelegram(
        report
    );
}

async function sendManualReport() {
    const report =
        await createReport(
            "📊 Текущие значения"
        );

    await sendTelegram(
        report
    );
}


// ======================================================
// SIGNAL CHECK
// ======================================================

async function checkSymbol(coin) {
    const data =
        await getCurrentPso(
            coin
        );

    const now =
        data.value;

    const candle5m =
        data.last5mOpenTime;


    // Уже обрабатывали эту
    // закрытую 5m свечу
    if (
        state.last5mCandle[coin] ===
        candle5m
    ) {
        return;
    }


    const previousSeen =
        state.lastPso[coin];


    console.log(
        coin,
        "5m:",
        new Date(
            candle5m
        ).toISOString(),
        "1H PSO:",
        formatPSO(now),
        "prev:",
        previousSeen !== undefined
            ? formatPSO(
                previousSeen
            )
            : "none",
        "last signal:",
        state.lastSignal[coin] || "none"
    );


    // ==========================================
    // SAME LOGIC AS:
    //
    // ta.crossover(higher2, signalLevel)
    // ta.crossunder(higher2, -signalLevel)
    //
    // но сравниваем значения 1H PSO
    // между соседними закрытыми 5m свечами.
    // ==========================================

    const upperSignal =
        previousSeen !== undefined &&
        previousSeen < SIGNAL_LEVEL &&
        now >= SIGNAL_LEVEL;


    const lowerSignal =
        previousSeen !== undefined &&
        previousSeen > -SIGNAL_LEVEL &&
        now <= -SIGNAL_LEVEL;


    // Сначала сохраняем новое состояние PSO
    state.lastPso[coin] =
        now;

    state.last5mCandle[coin] =
        candle5m;

    saveState();


    // ==========================================
    // UPPER
    //
    // Если последний ОТПРАВЛЕННЫЙ сигнал уже
    // был верхним — новый верхний игнорируем.
    //
    // Новый красный разрешается только после
    // того, как был отправлен зелёный.
    // ==========================================

    if (
        upperSignal &&
        state.lastSignal[coin] !== "upper"
    ) {
        state.lastSignal[coin] =
            "upper";

        saveState();

        await sendTelegram(
            `🔴 <b>${coin}</b>\n\n` +
            `<b>1H PSO вошёл в верхнюю зону</b>\n\n` +

            `Сейчас: <b>${
                formatPSO(now)
            }</b>\n` +

            `Предыдущее 5m значение: ${
                formatPSO(
                    previousSeen
                )
            }\n\n` +

            `Граница: +${SIGNAL_LEVEL}\n` +
            `График: 5m\n` +
            `PSO: 1H`
        );
    }


    // ==========================================
    // LOWER
    //
    // Если последний ОТПРАВЛЕННЫЙ сигнал уже
    // был нижним — новый нижний игнорируем.
    //
    // Новый зелёный разрешается только после
    // того, как был отправлен красный.
    // ==========================================

    if (
        lowerSignal &&
        state.lastSignal[coin] !== "lower"
    ) {
        state.lastSignal[coin] =
            "lower";

        saveState();

        await sendTelegram(
            `🟢 <b>${coin}</b>\n\n` +
            `<b>1H PSO вошёл в нижнюю зону</b>\n\n` +

            `Сейчас: <b>${
                formatPSO(now)
            }</b>\n` +

            `Предыдущее 5m значение: ${
                formatPSO(
                    previousSeen
                )
            }\n\n` +

            `Граница: -${SIGNAL_LEVEL}\n` +
            `График: 5m\n` +
            `PSO: 1H`
        );
    }
}


// ======================================================
// CHECK ALL
// ======================================================

let checking = false;

async function checkAll() {
    if (checking) {
        return;
    }

    checking = true;

    try {
        for (
            const coin
            of getCoins()
        ) {
            try {
                await checkSymbol(
                    coin
                );

            } catch (err) {
                console.error(
                    `${coin}:`,
                    err.message
                );
            }
        }

    } finally {
        checking = false;
    }
}


// ======================================================
// VALIDATE COIN
// ======================================================

async function coinExists(
    coin
) {
    const symbol =
        getSymbol(coin);

    const url =
        `${BINANCE_API}` +
        `/api/v3/exchangeInfo` +
        `?symbol=${symbol}`;

    try {
        const response =
            await fetch(url);

        return response.ok;

    } catch {
        return false;
    }
}


// ======================================================
// TELEGRAM COMMANDS
// ======================================================

let waitingForCoins = false;
let updateOffset = 0;


async function processTelegramMessage(
    message
) {
    if (!message) return;


    const chatId =
        String(
            message.chat?.id ||
            ""
        );

    const userId =
        String(
            message.from?.id ||
            ""
        );


    // Игнорируем вообще всех,
    // кроме заданного пользователя
    if (
        chatId !== USER_ID ||
        userId !== USER_ID
    ) {
        return;
    }


    const text =
        String(
            message.text ||
            ""
        ).trim();

    if (!text) {
        return;
    }


    // ==========================================
    // /start
    // ==========================================

    if (
        text === "/start" ||
        text.startsWith(
            "/start@"
        )
    ) {
        waitingForCoins =
            false;

        await sendTelegram(
            `<b>PSO Monitor</b>\n\n` +

            `График: 5m\n` +
            `PSO: 1H\n` +
            `Сигнал: ±${SIGNAL_LEVEL}\n\n` +

            `/check — проверить все монеты\n` +
            `/coins — изменить список`
        );

        return;
    }


    // ==========================================
    // /check
    // ==========================================

    if (
        text === "/check" ||
        text.startsWith(
            "/check@"
        )
    ) {
        waitingForCoins =
            false;

        await sendManualReport();

        return;
    }


    // ==========================================
    // /coins
    // ==========================================

    if (
        text === "/coins" ||
        text.startsWith(
            "/coins@"
        )
    ) {
        waitingForCoins =
            true;

        await sendTelegram(
            `<b>Сейчас отслеживаются:</b>\n\n` +

            `${getCoins().join(", ")}\n\n` +

            `Пришли новый список через запятую.\n\n` +

            `Например:\n` +
            `<code>BTC, ETH, SOL, XRP, ONDO</code>\n\n` +

            `USDT писать не нужно.`
        );

        return;
    }


    // ==========================================
    // NEW COIN LIST
    // ==========================================

    if (waitingForCoins) {
        const coins = [
            ...new Set(
                text
                    .split(",")
                    .map(normalizeCoin)
                    .filter(Boolean)
            )
        ];


        if (!coins.length) {
            await sendTelegram(
                "❌ Не удалось распознать список."
            );

            return;
        }


        const valid = [];
        const invalid = [];


        for (
            const coin
            of coins
        ) {
            const exists =
                await coinExists(
                    coin
                );

            if (exists) {
                valid.push(
                    coin
                );
            } else {
                invalid.push(
                    coin
                );
            }
        }


        if (!valid.length) {
            await sendTelegram(
                "❌ Ни одной USDT-пары не найдено."
            );

            return;
        }


        state.coins =
            valid;


        // Удаляем состояние монет,
        // которых больше нет в списке
        for (
            const coin
            of Object.keys(
                state.lastPso
            )
        ) {
            if (
                !valid.includes(
                    coin
                )
            ) {
                delete state.lastPso[
                    coin
                ];
            }
        }


        for (
            const coin
            of Object.keys(
                state.last5mCandle
            )
        ) {
            if (
                !valid.includes(
                    coin
                )
            ) {
                delete state.last5mCandle[
                    coin
                ];
            }
        }


        for (
            const coin
            of Object.keys(
                state.lastSignal
            )
        ) {
            if (
                !valid.includes(
                    coin
                )
            ) {
                delete state.lastSignal[
                    coin
                ];
            }
        }


        saveState();

        waitingForCoins =
            false;


        let answer =
            `✅ <b>Список обновлён</b>\n\n` +
            `${valid.join(", ")}`;


        if (invalid.length) {
            answer +=
                `\n\n⚠️ Не найдены:\n` +
                `${invalid.join(", ")}`;
        }


        await sendTelegram(
            answer
        );

        return;
    }
}


// ======================================================
// TELEGRAM POLLING
// ======================================================

async function telegramPolling() {
    while (true) {
        try {
            const updates =
                await telegramRequest(
                    "getUpdates",
                    {
                        offset:
                            updateOffset,

                        timeout:
                            30,

                        allowed_updates:
                            ["message"]
                    }
                );


            for (
                const update
                of updates
            ) {
                updateOffset =
                    update.update_id +
                    1;

                await processTelegramMessage(
                    update.message
                );
            }

        } catch (err) {
            console.error(
                "Telegram polling:",
                err.message
            );


            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000
                    )
            );
        }
    }
}


// ======================================================
// START
// ======================================================

async function main() {
    if (!BOT_TOKEN) {
        throw new Error(
            "Нет TELEGRAM_BOT_TOKEN"
        );
    }

    if (!USER_ID) {
        throw new Error(
            "Нет TELEGRAM_USER_ID"
        );
    }


    console.log(
        "PSO Monitor"
    );

    console.log(
        "Монеты:",
        getCoins().join(", ")
    );

    console.log(
        "Рабочий TF: 5m"
    );

    console.log(
        "PSO TF: 1H"
    );

    console.log(
        "Signal:",
        SIGNAL_LEVEL
    );


    // Отчёт при запуске
    await sendStartupReport();


    // Заполняем initial lastPso.
    //
    // Это важно:
    // при перезапуске бот не должен
    // прислать старый сигнал повторно.
    await checkAll();


    // Технически спрашиваем Binance
    // каждые N секунд.
    //
    // Но одна закрытая 5m свеча
    // обрабатывается только один раз.
    setInterval(
        checkAll,
        CHECK_INTERVAL
    );


    // Telegram команды
    telegramPolling();
}


main().catch(
    async err => {
        console.error(
            err
        );

        try {
            await sendTelegram(
                `❌ <b>Ошибка PSO Monitor</b>\n\n` +
                `${String(err.message || err)}`
            );
        } catch {}
    }
);
