require("dotenv").config();
const fs = require("fs");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID = String(process.env.TELEGRAM_USER_ID);

const PSO_PERIOD = Number(process.env.PSO_PERIOD || 32);
const PSO_SMOOTH = Number(process.env.PSO_SMOOTH || 5);
const SIGNAL_LEVEL = Number(process.env.SIGNAL_LEVEL || 0.8);

const CHECK_INTERVAL =
    Number(process.env.CHECK_INTERVAL || 30) * 1000;

const STATE_FILE = "./state.json";
const BINANCE_API = "https://api.binance.com";


// ======================================================
// STATE
// ======================================================

function defaultState() {
    const envCoins = (process.env.SYMBOLS || "BTC,ETH,SOL")
        .split(",")
        .map(normalizeCoin)
        .filter(Boolean);

    return {
        coins: envCoins,
        handledSignals: {}
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return defaultState();
        }

        const saved = JSON.parse(
            fs.readFileSync(STATE_FILE, "utf8")
        );

        return {
            coins:
                Array.isArray(saved.coins) &&
                saved.coins.length
                    ? saved.coins.map(normalizeCoin)
                    : defaultState().coins,

            handledSignals:
                saved.handledSignals || {}
        };

    } catch {
        return defaultState();
    }
}

function saveState() {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(state, null, 2)
    );
}

let state = loadState();


// ======================================================
// COINS
// ======================================================

function normalizeCoin(coin) {
    if (!coin) return "";

    let value = coin
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");

    // Если написал BTCUSDT — тоже принимаем,
    // но внутри храним просто BTC
    if (value.endsWith("USDT")) {
        value = value.slice(0, -4);
    }

    return value;
}

function getSymbol(coin) {
    return `${normalizeCoin(coin)}USDT`;
}

function getCoins() {
    return state.coins;
}


// ======================================================
// TELEGRAM
// ======================================================

async function telegramRequest(method, data = {}) {
    const url =
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    const response = await fetch(url, {
        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error(
            `Telegram error: ${JSON.stringify(result)}`
        );
    }

    return result.result;
}

async function sendTelegram(text) {
    return telegramRequest("sendMessage", {
        chat_id: USER_ID,
        text,
        parse_mode: "HTML"
    });
}


// ======================================================
// BINANCE
// ======================================================

async function getCandles(coin) {
    const symbol = getSymbol(coin);

    const url =
        `${BINANCE_API}/api/v3/klines` +
        `?symbol=${symbol}` +
        `&interval=1h` +
        `&limit=500`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `${symbol}: Binance ${response.status}`
        );
    }

    const data = await response.json();

    return data.map(row => ({
        openTime: Number(row[0]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        closeTime: Number(row[6])
    }));
}


// ======================================================
// PSO
// ======================================================

function calculatePSO(candles) {
    const alpha =
        2 / (1 + PSO_SMOOTH);

    let ema0 = 0;
    let ema1 = 0;

    const result = [];

    for (let i = 0; i < candles.length; i++) {
        const start =
            Math.max(
                0,
                i - PSO_PERIOD + 1
            );

        let mini = Infinity;
        let maxi = -Infinity;

        for (let j = start; j <= i; j++) {
            mini = Math.min(
                mini,
                candles[j].low
            );

            maxi = Math.max(
                maxi,
                candles[j].high
            );
        }

        const priceSpan =
            maxi - mini;

        const sto =
            priceSpan !== 0
                ? 10 * (
                    (
                        candles[i].close - mini
                    ) /
                    priceSpan -
                    0.5
                )
                : 0;

        ema0 =
            ema0 +
            alpha * (sto - ema0);

        ema1 =
            ema1 +
            alpha * (ema0 - ema1);

        const iexp =
            Math.exp(ema1);

        const pso =
            (iexp - 1) /
            (iexp + 1);

        result.push({
            candle: candles[i],
            value: pso
        });
    }

    return result;
}


// ======================================================
// HELPERS
// ======================================================

function formatPSO(value) {
    return value.toFixed(4);
}

function getZone(value) {
    if (value >= SIGNAL_LEVEL) {
        return "🔴";
    }

    if (value <= -SIGNAL_LEVEL) {
        return "🟢";
    }

    return "⚪";
}


// ======================================================
// GET PSO
// ======================================================

async function getPSO(coin) {
    const candles =
        await getCandles(coin);

    const values =
        calculatePSO(candles);

    if (values.length < 2) {
        throw new Error(
            `${coin}: недостаточно данных`
        );
    }

    return {
        current:
            values[values.length - 1],

        previous:
            values[values.length - 2]
    };
}


// ======================================================
// REPORT
// ======================================================

async function createReport(title) {
    const lines = [
        `<b>${title}</b>`,
        "",
        `1H | граница ±${SIGNAL_LEVEL}`,
        ""
    ];

    for (const coin of getCoins()) {
        try {
            const { current } =
                await getPSO(coin);

            lines.push(
                `${getZone(current.value)} ` +
                `<b>${coin}</b>: ` +
                `${formatPSO(current.value)}`
            );

        } catch (err) {
            console.error(err);

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
            "🚀 PSO monitor запущен"
        );

    await sendTelegram(report);
}

async function sendManualReport() {
    const report =
        await createReport(
            "📊 Текущие значения PSO"
        );

    await sendTelegram(report);
}


// ======================================================
// SIGNALS
// ======================================================

async function checkSymbol(coin) {
    const {
        current,
        previous
    } = await getPSO(coin);

    const now =
        current.value;

    const prev =
        previous.value;


    const upperSignal =
        now >= SIGNAL_LEVEL &&
        prev < SIGNAL_LEVEL;


    const lowerSignal =
        now <= -SIGNAL_LEVEL &&
        prev > -SIGNAL_LEVEL;


    const candleTime =
        current.candle.openTime;


    const upperKey =
        `${coin}_${candleTime}_UP`;

    const lowerKey =
        `${coin}_${candleTime}_DOWN`;


    if (
        upperSignal &&
        !state.handledSignals[upperKey]
    ) {
        state.handledSignals[upperKey] = true;

        saveState();

        await sendTelegram(
            `🔴 <b>${coin}</b>\n\n` +
            `PSO вошёл выше +${SIGNAL_LEVEL}\n\n` +
            `Сейчас: <b>${formatPSO(now)}</b>\n` +
            `До этого: ${formatPSO(prev)}\n` +
            `TF: 1H`
        );
    }


    if (
        lowerSignal &&
        !state.handledSignals[lowerKey]
    ) {
        state.handledSignals[lowerKey] = true;

        saveState();

        await sendTelegram(
            `🟢 <b>${coin}</b>\n\n` +
            `PSO вошёл ниже -${SIGNAL_LEVEL}\n\n` +
            `Сейчас: <b>${formatPSO(now)}</b>\n` +
            `До этого: ${formatPSO(prev)}\n` +
            `TF: 1H`
        );
    }
}


// ======================================================
// AUTO CHECK
// ======================================================

let checking = false;

async function checkAll() {
    if (checking) return;

    checking = true;

    try {
        for (const coin of getCoins()) {
            try {
                await checkSymbol(coin);
            } catch (err) {
                console.error(
                    coin,
                    err.message
                );
            }
        }
    } finally {
        checking = false;
    }
}


// ======================================================
// TELEGRAM COMMANDS
// ======================================================

let waitingForCoins = false;
let updateOffset = 0;

async function processTelegramMessage(message) {
    if (!message) return;

    const chatId =
        String(message.chat?.id || "");

    const userId =
        String(message.from?.id || "");

    // Полностью игнорируем всех остальных
    if (
        chatId !== USER_ID ||
        userId !== USER_ID
    ) {
        return;
    }

    const text =
        String(message.text || "").trim();

    if (!text) return;


    // --------------------------------------------
    // /start
    // --------------------------------------------

    if (
        text === "/start" ||
        text.startsWith("/start@")
    ) {
        waitingForCoins = false;

        await sendTelegram(
            `<b>PSO Monitor</b>\n\n` +
            `/check — проверить все монеты\n` +
            `/coins — изменить список монет`
        );

        return;
    }


    // --------------------------------------------
    // /check
    // --------------------------------------------

    if (
        text === "/check" ||
        text.startsWith("/check@")
    ) {
        waitingForCoins = false;

        await sendManualReport();

        return;
    }


    // --------------------------------------------
    // /coins
    // --------------------------------------------

    if (
        text === "/coins" ||
        text.startsWith("/coins@")
    ) {
        waitingForCoins = true;

        const list =
            getCoins().join(", ");

        await sendTelegram(
            `<b>Сейчас отслеживаются:</b>\n\n` +
            `${list}\n\n` +
            `Пришли новый список через запятую.\n\n` +
            `Например:\n` +
            `<code>BTC, ETH, SOL, TON</code>\n\n` +
            `USDT писать не нужно.`
        );

        return;
    }


    // --------------------------------------------
    // NEW COIN LIST
    // --------------------------------------------

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
                "❌ Не получилось распознать список."
            );

            return;
        }


        // Проверяем, существуют ли пары на Binance
        const validCoins = [];
        const invalidCoins = [];


        for (const coin of coins) {
            try {
                const symbol =
                    getSymbol(coin);

                const response = await fetch(
                    `${BINANCE_API}/api/v3/exchangeInfo?symbol=${symbol}`
                );

                if (response.ok) {
                    validCoins.push(coin);
                } else {
                    invalidCoins.push(coin);
                }

            } catch {
                invalidCoins.push(coin);
            }
        }


        if (!validCoins.length) {
            await sendTelegram(
                "❌ Ни одной подходящей USDT-пары на Binance не найдено."
            );

            return;
        }


        state.coins = validCoins;
        saveState();

        waitingForCoins = false;


        let answer =
            `✅ <b>Список обновлён</b>\n\n` +
            `${validCoins.join(", ")}`;

        if (invalidCoins.length) {
            answer +=
                `\n\n⚠️ Не найдены:\n` +
                `${invalidCoins.join(", ")}`;
        }

        await sendTelegram(answer);

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
                        offset: updateOffset,
                        timeout: 30,
                        allowed_updates: [
                            "message"
                        ]
                    }
                );

            for (const update of updates) {
                updateOffset =
                    update.update_id + 1;

                await processTelegramMessage(
                    update.message
                );
            }

        } catch (err) {
            console.error(
                "Telegram polling:",
                err.message
            );

            await new Promise(resolve =>
                setTimeout(resolve, 3000)
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
        "Следим:",
        getCoins().join(", ")
    );


    await sendStartupReport();

    await checkAll();


    setInterval(
        checkAll,
        CHECK_INTERVAL
    );


    telegramPolling();
}

main().catch(console.error);