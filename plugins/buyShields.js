// Cumpara scuturi la pornirea botului (cand activezi plugin-ul pe site, botul reporneste):
// trimite "count" cereri a cate 1000 de scuturi (maximul pe o cerere), la 10 secunde una de alta.
// Dupa cumparare dezactiveaza plugin-ul, altfel cumpara din nou la fiecare repornire a botului
// (protectia "cooldownMinutes" opreste doar cumpararile repetate la reporniri apropiate).
if (require("node:worker_threads").isMainThread)
    return module.exports = {
        description: "Cumpara scuturi (cate 1000 pe cerere) o data la activare - dezactiveaza dupa",
        pluginOptions: [
            {
                type: "Text",
                key: "count",
                default: "1"
            },
            {
                type: "Text",
                key: "cooldownMinutes",
                default: "10"
            }
        ]
    }

const fs = require("node:fs")
const path = require("node:path")
const { events, botConfig, sendXT, xtHandler } = require("../ggeBot.js")
const err = require("../err.json")

const SHIELDS_PER_REQUEST = 1000 // maximul acceptat de server pe o cerere
const DELAY_MS = 10 * 1000

const pluginOptions = botConfig.plugins[path.basename(__filename).slice(0, -3)] ?? {}
const count = Math.floor(Number(pluginOptions.count || 1))
const cooldownMinutes = Number(pluginOptions.cooldownMinutes || 10)

// cand am trimis ultima cerere, per bot - ca sa nu cumparam iar daca botul reporneste imediat
const STATE_FILE = path.join(__dirname, "..", "logs", `buyShields_${botConfig.name ?? "bot"}.json`)

function readLastBuy() {
    try {
        return Number(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).lastBuy) || 0
    } catch {
        return 0
    }
}

function writeLastBuy(done) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
        fs.writeFileSync(STATE_FILE, JSON.stringify({ lastBuy: Date.now(), done, count }))
    } catch (e) {
        console.warn(`[Scuturi] nu pot scrie ${STATE_FILE}: ${e.message}`)
    }
}

// asteapta raspunsul la sbp (fara waitForResult, ca timeout-urile lui numara spre process.exit)
function waitSbp(timeout) {
    return new Promise(resolve => {
        const listener = (obj, result) => {
            clearTimeout(timer)
            resolve({ obj, result })
        }
        const timer = setTimeout(() => {
            xtHandler.removeListener("sbp", listener)
            resolve({ result: "TIMEOUT" })
        }, timeout)
        xtHandler.once("sbp", listener)
    })
}

events.once("load", async () => {
    if (!(count > 0))
        return console.warn(`[Scuturi] numar de cereri invalid: ${pluginOptions.count}`)

    const minutesSince = (Date.now() - readLastBuy()) / 60000
    if (minutesSince < cooldownMinutes)
        return console.warn(`[Scuturi] ultima cumparare a fost acum ${minutesSince.toFixed(1)} minute, sar peste ` +
            `(cooldown ${cooldownMinutes} min). Dezactiveaza plugin-ul daca nu mai vrei scuturi.`)

    console.info(`[Scuturi] Incep: ${count} cereri x ${SHIELDS_PER_REQUEST} scuturi, la ${DELAY_MS / 1000}s una de alta`)

    let done = 0
    for (let i = 0; i < count; i++) {
        if (i > 0)
            await new Promise(r => setTimeout(r, DELAY_MS))

        // marcam inainte de trimitere, ca o repornire in timpul cumpararii sa nu o ia de la capat
        writeLastBuy(done)

        const response = waitSbp(10000)
        await sendXT("sbp", JSON.stringify({
            PID: 36, BT: 0, TID: 27, AMT: SHIELDS_PER_REQUEST,
            KID: 0, AID: -1, PC2: -1, BA: 0, PWR: 0, _PO: -1
        }))
        const { obj, result } = await response

        if (result != 0) {
            console.warn(`[Scuturi] Cererea ${i + 1}/${count} a esuat: ${err[result] ?? result} ${obj ? JSON.stringify(obj) : ""}. ` +
                `Ma opresc (cumparate pana acum: ${done * SHIELDS_PER_REQUEST}).`)
            writeLastBuy(done)
            return
        }

        done++
        console.info(`[Scuturi] Cererea ${done}/${count}: +${SHIELDS_PER_REQUEST} scuturi (total ${done * SHIELDS_PER_REQUEST})`)
    }

    writeLastBuy(done)
    console.info(`[Scuturi] Gata: ${done * SHIELDS_PER_REQUEST} scuturi cumparate. Dezactiveaza plugin-ul ca sa nu cumpere iar la urmatoarea repornire.`)
})
