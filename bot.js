require("dotenv").config();
const fs = require("fs");

// CONFIG
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID = String(process.env.TELEGRAM_USER_ID);

const PSO_PERIOD = Number(process.env.PSO_PERIOD || 32);
const PSO_SMOOTH = Number(process.env.PSO_SMOOTH || 5);
const SIGNAL_LEVEL = 0.9;

const CHECK_INTERVAL = 5 * 60 * 1000;
const CANDLE_DELAY = 2000;
const SIGNAL_COOLDOWN = 12 * 60 * 60 * 1000;

const BINANCE_API = "https://data-api.binance.vision";
const STATE_FILE = process.env.STATE_FILE || "./state.json";

// COINS
function normalizeCoin(coin) {
    if (!coin) return "";

    let value = String(coin).trim().toUpperCase().replace(/\s+/g, "");

    if (value.endsWith("USDT")) {
        value = value.slice(0, -4);
    }

    return value;
}

function getSymbol(coin) {
    return `${normalizeCoin(coin)}USDT`;
}

// STATE
function defaultState() {
    const coins = (process.env.SYMBOLS || "BTC,ETH,SOL").split(",").map(normalizeCoin).filter(Boolean);

    return {
        coins,
        lastPso: {},
        last5mCandle: {},
        lastSignal: {},
        lastSignalAt: {}
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return defaultState();
        }

        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

        return {
            coins: Array.isArray(saved.coins) && saved.coins.length ? saved.coins.map(normalizeCoin).filter(Boolean) : defaultState().coins,
            lastPso: saved.lastPso || {},
            last5mCandle: saved.last5mCandle || {},
            lastSignal: saved.lastSignal || {},
            lastSignalAt: saved.lastSignalAt || {}
        };
    } catch (err) {
        console.error("Ошибка state.json:", err.message);
        return defaultState();
    }
}

let state = loadState();

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getCoins() {
    return state.coins;
}

// TELEGRAM
async function telegramRequest(method, data = {}) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error(`Telegram: ${JSON.stringify(result)}`);
    }

    return result.result;
}

async function sendTelegram(text) {
    return telegramRequest("sendMessage", {
        chat_id: USER_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
    });
}

// BINANCE 5M
async function fetch5mBatch(symbol, endTime = null) {
    let url = `${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=5m&limit=1000`;

    if (endTime !== null) {
        url += `&endTime=${endTime}`;
    }

    const response = await fetch(url);

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`${symbol}: Binance ${response.status}: ${body}`);
    }

    return response.json();
}

// Около 3000 свечей 5m для прогрева 1H PSO.
async function get5mCandles(coin) {
    const symbol = getSymbol(coin);
    const all = [];
    let endTime = null;

    for (let page = 0; page < 3; page++) {
        const data = await fetch5mBatch(symbol, endTime);

        if (!Array.isArray(data) || !data.length) {
            break;
        }

        all.unshift(...data);

        const oldestOpenTime = Number(data[0][0]);
        endTime = oldestOpenTime - 1;

        if (data.length < 1000) {
            break;
        }
    }

    const map = new Map();

    for (const row of all) {
        map.set(Number(row[0]), row);
    }

    const rows = [...map.values()].sort((a, b) => Number(a[0]) - Number(b[0]));

    return rows.map(row => ({
        openTime: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        closeTime: Number(row[6])
    }));
}

// ONLY CLOSED 5M CANDLES
function removeOpen5mCandle(candles) {
    const now = Date.now();
    return candles.filter(candle => candle.closeTime < now);
}

// 5M -> 1H AGGREGATION
function getHourStart(timestamp) {
    const HOUR = 60 * 60 * 1000;
    return Math.floor(timestamp / HOUR) * HOUR;
}

function aggregate5mTo1h(candles5m) {
    const hourly = [];
    let currentHour = null;
    let current = null;

    for (const candle of candles5m) {
        const hourStart = getHourStart(candle.openTime);

        if (currentHour === null || hourStart !== currentHour) {
            if (current) {
                hourly.push(current);
            }

            currentHour = hourStart;

            current = {
                openTime: hourStart,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                closeTime: candle.closeTime
            };
        } else {
            current.high = Math.max(current.high, candle.high);
            current.low = Math.min(current.low, candle.low);
            current.close = candle.close;
            current.closeTime = candle.closeTime;
        }
    }

    if (current) {
        hourly.push(current);
    }

    return hourly;
}

// PSO
function calculatePSO(candles) {
    const alpha = 2.0 / (1.0 + PSO_SMOOTH);

    let ema0 = 0;
    let ema1 = 0;

    const result = [];

    for (let i = 0; i < candles.length; i++) {
        const start = Math.max(0, i - PSO_PERIOD + 1);

        let mini = Infinity;
        let maxi = -Infinity;

        for (let j = start; j <= i; j++) {
            mini = Math.min(mini, candles[j].low);
            maxi = Math.max(maxi, candles[j].high);
        }

        const priceSpan = maxi - mini;
        const sto = priceSpan !== 0 ? 10.0 * ((candles[i].close - mini) / priceSpan - 0.5) : 0.0;

        const prevEma0 = ema0;
        const prevEma1 = ema1;

        ema0 = prevEma0 + alpha * (sto - prevEma0);
        ema1 = prevEma1 + alpha * (ema0 - prevEma1);

        const iexp = Math.exp(ema1);
        const pso = (iexp - 1.0) / (iexp + 1.0);

        result.push({
            candle: candles[i],
            value: pso
        });
    }

    return result;
}

// CURRENT 1H PSO FROM 5M DATA
async function getCurrentPso(coin) {
    let candles5m = await get5mCandles(coin);
    candles5m = removeOpen5mCandle(candles5m);

    if (candles5m.length < 100) {
        throw new Error(`${coin}: мало 5m данных`);
    }

    const last5m = candles5m[candles5m.length - 1];
    const hourly = aggregate5mTo1h(candles5m);
    const values = calculatePSO(hourly);

    if (!values.length) {
        throw new Error(`${coin}: PSO не рассчитан`);
    }

    const current = values[values.length - 1];

    return {
        value: current.value,
        hourOpenTime: current.candle.openTime,
        last5mOpenTime: last5m.openTime,
        last5mCloseTime: last5m.closeTime
    };
}

// FORMAT
function formatPSO(value) {
    return Number(value).toFixed(4);
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

// REPORT
async function createReport(title) {
    const lines = [
        `<b>${title}</b>`,
        "",
        "График: <b>5m</b>",
        "Индикатор: <b>1H PSO</b>",
        `Граница: <b>±${SIGNAL_LEVEL}</b>`,
        ""
    ];

    for (const coin of getCoins()) {
        try {
            const data = await getCurrentPso(coin);
            lines.push(`${getZone(data.value)} <b>${coin}</b>: ${formatPSO(data.value)}`);
        } catch (err) {
            console.error(`${coin}:`, err.message);
            lines.push(`❌ <b>${coin}</b>: ошибка`);
        }
    }

    return lines.join("\n");
}

async function sendStartupReport() {
    const report = await createReport("🚀 PSO Monitor запущен");
    await sendTelegram(report);
}

async function sendManualReport() {
    const report = await createReport("📊 Текущие значения");
    await sendTelegram(report);
}

// SIGNAL CHECK
async function checkSymbol(coin) {
    const data = await getCurrentPso(coin);
    const now = data.value;
    const candle5m = data.last5mOpenTime;

    // Каждую закрытую 5m свечу обрабатываем один раз.
    if (state.last5mCandle[coin] === candle5m) {
        return;
    }

    const previousSeen = state.lastPso[coin];

    console.log(
        coin,
        "5m:",
        new Date(candle5m).toISOString(),
        "1H PSO:",
        formatPSO(now),
        "prev:",
        previousSeen !== undefined ? formatPSO(previousSeen) : "none",
        "last signal:",
        state.lastSignal[coin] || "none"
    );

    // Красный: PSO вышел из верхней зоны, опустившись ниже +0.9.
    const upperSignal = previousSeen !== undefined && previousSeen >= SIGNAL_LEVEL && now < SIGNAL_LEVEL;

    // Зелёный: PSO вышел из нижней зоны, поднявшись выше -0.9.
    const lowerSignal = previousSeen !== undefined && previousSeen <= -SIGNAL_LEVEL && now > -SIGNAL_LEVEL;

    state.lastPso[coin] = now;
    state.last5mCandle[coin] = candle5m;
    saveState();

    const signal = upperSignal ? "upper" : lowerSignal ? "lower" : null;
    if (!signal) return;

    const sentAt = Date.now();
    const previousSentAt = state.lastSignalAt[coin]?.[signal];

    // 12 часов отдельно для каждой монеты и каждого цвета.
    // Противоположный цвет не блокируется кулдауном этого цвета.
    if (previousSentAt !== undefined && sentAt - previousSentAt < SIGNAL_COOLDOWN) {
        return;
    }

    await sendTelegram(`${signal === "upper" ? "🔴" : "🟢"} ${coin}`);

    state.lastSignal[coin] = signal;
    state.lastSignalAt[coin] ??= {};
    state.lastSignalAt[coin][signal] = sentAt;
    saveState();
}

// CHECK ALL
let checking = false;

async function checkAll() {
    if (checking) {
        return;
    }

    checking = true;

    try {
        for (const coin of getCoins()) {
            try {
                await checkSymbol(coin);
            } catch (err) {
                console.error(`${coin}:`, err.message);
            }
        }
    } finally {
        checking = false;
    }
}

// VALIDATE COIN
async function coinExists(coin) {
    const symbol = getSymbol(coin);
    const url = `${BINANCE_API}/api/v3/exchangeInfo?symbol=${symbol}`;

    try {
        const response = await fetch(url);
        return response.ok;
    } catch {
        return false;
    }
}

// TELEGRAM COMMANDS
let waitingForCoins = false;
let updateOffset = 0;

async function processTelegramMessage(message) {
    if (!message) return;

    const chatId = String(message.chat?.id || "");
    const userId = String(message.from?.id || "");

    if (chatId !== USER_ID || userId !== USER_ID) {
        return;
    }

    const text = String(message.text || "").trim();

    if (!text) {
        return;
    }

    // /start
    if (text === "/start" || text.startsWith("/start@")) {
        waitingForCoins = false;

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

    // /check
    if (text === "/check" || text.startsWith("/check@")) {
        waitingForCoins = false;
        await sendManualReport();
        return;
    }

    // /coins
    if (text === "/coins" || text.startsWith("/coins@")) {
        waitingForCoins = true;

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

    // NEW COIN LIST
    if (waitingForCoins) {
        const coins = [...new Set(text.split(",").map(normalizeCoin).filter(Boolean))];

        if (!coins.length) {
            await sendTelegram("❌ Не удалось распознать список.");
            return;
        }

        const valid = [];
        const invalid = [];

        for (const coin of coins) {
            const exists = await coinExists(coin);

            if (exists) {
                valid.push(coin);
            } else {
                invalid.push(coin);
            }
        }

        if (!valid.length) {
            await sendTelegram("❌ Ни одной USDT-пары не найдено.");
            return;
        }

        state.coins = valid;

        for (const coin of Object.keys(state.lastPso)) {
            if (!valid.includes(coin)) {
                delete state.lastPso[coin];
            }
        }

        for (const coin of Object.keys(state.last5mCandle)) {
            if (!valid.includes(coin)) {
                delete state.last5mCandle[coin];
            }
        }

        for (const coin of Object.keys(state.lastSignal)) {
            if (!valid.includes(coin)) {
                delete state.lastSignal[coin];
            }
        }

        for (const coin of Object.keys(state.lastSignalAt)) {
            if (!valid.includes(coin)) {
                delete state.lastSignalAt[coin];
            }
        }

        saveState();
        waitingForCoins = false;

        let answer = `✅ <b>Список обновлён</b>\n\n${valid.join(", ")}`;

        if (invalid.length) {
            answer += `\n\n⚠️ Не найдены:\n${invalid.join(", ")}`;
        }

        await sendTelegram(answer);
        return;
    }
}

// TELEGRAM POLLING
async function telegramPolling() {
    while (true) {
        try {
            const updates = await telegramRequest("getUpdates", {
                offset: updateOffset,
                timeout: 30,
                allowed_updates: ["message"]
            });

            for (const update of updates) {
                updateOffset = update.update_id + 1;
                await processTelegramMessage(update.message);
            }
        } catch (err) {
            console.error("Telegram polling:", err.message);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

// Проверки на :00, :05, :10, :15... плюс 2 секунды.
function scheduleChecks() {
    const now = Date.now();
    const nextCheck = (Math.floor(now / CHECK_INTERVAL) + 1) * CHECK_INTERVAL + CANDLE_DELAY;

    setTimeout(() => {
        scheduleChecks();
        checkAll().catch(err => console.error("PSO check:", err.message));
    }, nextCheck - now);
}

// START
async function main() {
    if (!BOT_TOKEN) {
        throw new Error("Нет TELEGRAM_BOT_TOKEN");
    }

    if (!USER_ID) {
        throw new Error("Нет TELEGRAM_USER_ID");
    }

    console.log("PSO Monitor");
    console.log("Монеты:", getCoins().join(", "));
    console.log("Рабочий TF: 5m");
    console.log("PSO TF: 1H");
    console.log("Signal:", SIGNAL_LEVEL);

    await sendStartupReport();
    await checkAll();

    scheduleChecks();
    telegramPolling();
}

main().catch(async err => {
    console.error(err);

    try {
        await sendTelegram(`❌ <b>Ошибка PSO Monitor</b>\n\n${String(err.message || err)}`);
    } catch {}
});
