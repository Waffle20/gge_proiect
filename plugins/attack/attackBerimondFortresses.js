if (require("node:worker_threads").isMainThread)
    return module.exports = {
        pluginOptions: [
            {
                type: "Text",
                key: "commanderWhiteList",
                default: "1-99"
            }
        ]
    }

const { castles, AreaType, KingdomID, movementEvents } = require("../../protocols.js")
const { waitToAttack } = require("./attack.js")
const { waitForCommanderAvailable, freeCommander, useCommander } = require("../commander.js")
const { sendXT, waitForResult, botConfig, events, xtHandler, playerInfo } = require("../../ggeBot.js")
const err = require("../../err.json")

const pluginOptions = botConfig.plugins[require("path").basename(__filename).slice(0, -3)] ?? {}

// --- Compoziția atacului, editabilă direct aici ---
const UNIT_WODID = 216 //2069 - wodid archer lvl10 10 oroare
const UNIT_AMOUNT = 32 // trebuie sa fie egal cu TROOPS_PER_COMMANDER din berimondTroopResupply
const TOOL_WODID = 620
// maximul de unelte pe flanc difera in functie de linie
const TOOL_AMOUNT_MIDDLE = 40 // linia de mijloc
const TOOL_AMOUNT_OTHER = 30  // liniile de sus si de jos (tintele date de fnt)
const FLANK = "L" // "L" = stanga, "R" = dreapta, "M" = mijloc

// --- Linia de mijloc ---
// Fortaretele din Berimond sunt pe 3 linii (lanturi independente) pana la capitala.
// Pe harta (gaa), o fortareata arata asa:
//   [17, X, Y, -410, distrusa(0/1), [[X_anterior, Y_anterior]], -1, nivel, atacuri_ramase, index]
// iar capitala: [18, X, Y, -410, [[capat linie], [capat linie], [capat linie]], ...]
// Mai intai terminam linia de mijloc, apoi trecem pe fnt normal.
const CAPITAL_X = 1539
const CAPITAL_Y = 60
const CAPITAL_TYPE = 18 // tipul capitalei pe harta; pe ea nu o atacam niciodata
const SCAN_CHUNK = 100 // marimea unei cereri gaa
const SCAN_Y_MARGIN = 80 // cat scanam peste/sub dreapta castel-capitala
// fortareata activa o verificam pe harta doar cand cra da eroare, plus o data la intervalul asta
// (plasa de siguranta daca serverul ar accepta atacuri pe o fortareata deja distrusa)
const VERIFY_INTERVAL_MS = 1000 * 60 * 15
const NO_RESPONSE_DELAY_MS = 1000 * 30 // pauza cand serverul nu raspunde la cererea de harta
const TROOP_POLL_MS = 1000 * 5         // cat de des ne uitam in inventarul local cand nu avem trupe (fara cereri)
const TROOP_REFRESH_MS = 1000 * 60     // cat de des cerem inventarul de la server cat timp asteptam trupe

// erori de la cra care nu au legatura cu fortareata, deci nu cer verificarea ei
const UNRELATED_ERRORS = ["MISSING_UNITS", "LORD_IS_USED", "ATTACK_TOO_MANY_UNITS", "CANT_START_NEW_ARMIES", "MOVEMENT_HAS_NO_UNITS"]

const AI_DESTROYED = 4
const AI_PREREQ = 5
const AI_LEVEL = 7
const AI_REMAINING = 8

// --- Comandanti invinsi ---
// commander.js elibereaza comandantul doar cand vede armata intorcandu-se. La infrangere totala nu exista
// intoarcere, deci ar ramane "folosit" pana la repornire. Daca dupa impact nu apare nicio intoarcere
// in DEFEAT_GRACE_MS, il eliberam noi (fara cereri la server).
const DEFEAT_GRACE_MS = 1000 * 60
const DEFEAT_GRACE_MAX_MS = 1000 * 60 * 5
let defeatGrace = DEFEAT_GRACE_MS
const pendingReturns = new Map() // lordID -> { impactAt, timer } : atacuri pentru care asteptam intoarcerea
const forceFreed = new Map()     // lordID -> impactAt : eliberati de noi, neconfirmati inca de un cra reusit

function watchReturn(lordID, impactAt, releaseAt = impactAt + defeatGrace) {
    clearTimeout(pendingReturns.get(lordID)?.timer)
    const timer = setTimeout(() => {
        pendingReturns.delete(lordID)
        forceFreed.set(lordID, impactAt)
        console.info(`[Berimond] Comandantul ${lordID} nu are intoarcere dupa atac (infrangere), il refolosesc`)
        freeCommander(lordID)
    }, Math.max(0, releaseAt - Date.now()))
    pendingReturns.set(lordID, { impactAt, timer })
}

function stopWatching(lordID) {
    clearTimeout(pendingReturns.get(lordID)?.timer)
    pendingReturns.delete(lordID)
    forceFreed.delete(lordID)
}

// serverul spune ca un comandant e inca plecat: am eliberat prea devreme, asa ca asteptam mai mult cu toti
// (8 erori LORD_IS_USED opresc botul, deci nu lasam eroarea sa se repete)
function onLordIsUsed(lordID) {
    const wasForced = [...forceFreed]
    forceFreed.clear()
    defeatGrace = Math.min(defeatGrace * 2, DEFEAT_GRACE_MAX_MS)
    console.warn(`[Berimond] Comandantul ${lordID} e inca plecat, astept ${defeatGrace / 1000}s dupa impact de acum incolo`)

    for (const [id, { impactAt }] of [...pendingReturns])
        watchReturn(id, impactAt)
    for (const [id, impactAt] of wasForced) {
        useCommander(id)
        watchReturn(id, impactAt)
    }
    useCommander(lordID)
    watchReturn(lordID, Date.now())
}

// atacurile noastre spre fortarete, inclusiv cele plecate inainte de repornirea botului
movementEvents.on("outgoing", movement => {
    if (movement.kingdomID != KingdomID.berimond || movement.owner.ownerID != playerInfo.playerID)
        return
    if (movement.targetOwner.ownerID == playerInfo.playerID || movement.targetAttack?.type != AreaType.watchTower)
        return
    const impactAt = Date.now() + Math.max(0, movement.totalTime - (movement.deltaTime - Date.now()))
    forceFreed.delete(movement.lord.lordID)
    watchReturn(movement.lord.lordID, impactAt)
})

// armata se intoarce (sau a ajuns): de aici se ocupa commander.js
for (const event of ["returning", "return"])
    movementEvents.on(event, movement => {
        if (movement.targetOwner.ownerID == playerInfo.playerID)
            stopWatching(movement.lord.lordID)
    })

const emptyFlank = () => ({ T: [], U: [] })
const loadedFlank = toolAmount => ({ T: [[TOOL_WODID, toolAmount]], U: [[UNIT_WODID, UNIT_AMOUNT]] })

// trimite un gaa brut si asteapta raspunsul pentru dreptunghiul cerut
// (fara waitForResult, ca timeout-urile lui numara spre process.exit)
function rawGaa(kingdomID, x1, y1, x2, y2) {
    return new Promise(resolve => {
        const inRect = ai => ai[1] >= x1 && ai[1] <= x2 && ai[2] >= y1 && ai[2] <= y2
        const listener = (obj, result) => {
            if (result != 0) return done({ result, AI: [] })
            if (obj?.KID != kingdomID) return
            const ai = Array.from(obj.AI ?? [])
            if (!ai.every(inRect)) return
            done({ result: 0, AI: ai })
        }
        const timer = setTimeout(() => done({ result: "TIMEOUT", AI: [] }), 8000)
        function done(r) {
            clearTimeout(timer)
            xtHandler.removeListener("gaa", listener)
            resolve(r)
        }
        xtHandler.on("gaa", listener)
        sendXT("gaa", JSON.stringify({ KID: kingdomID, AX1: x1, AY1: y1, AX2: x2, AY2: y2 }))
    })
}

const key = (x, y) => `${x}:${y}`

/**
 * Scaneaza zona castel -> capitala si intoarce lista fortaretelor ramase pe linia de mijloc,
 * in ordine: [activa, urmatoarea, ..., ultima inainte de capitala]. Lista goala = linia e terminata.
 */
async function scanMiddleLine(kingdomID, SX, SY) {
    const minX = Math.min(SX, CAPITAL_X)
    const maxX = Math.max(SX, CAPITAL_X) + 5
    const minY = Math.max(0, Math.min(SY, CAPITAL_Y) - SCAN_Y_MARGIN)
    const maxY = Math.max(SY, CAPITAL_Y) + SCAN_Y_MARGIN

    const map = new Map()
    for (let x = minX; x <= maxX; x += SCAN_CHUNK) {
        for (let y = minY; y <= maxY; y += SCAN_CHUNK) {
            const r = await rawGaa(kingdomID, x, y, Math.min(x + SCAN_CHUNK - 1, maxX), Math.min(y + SCAN_CHUNK - 1, maxY))
            if (r.result != 0)
                throw Object.assign(new Error(`gaa ${x}:${y} a esuat: ${r.result}`), { noResponse: r.result == "TIMEOUT" })
            for (const ai of r.AI)
                map.set(key(ai[1], ai[2]), ai)
        }
    }

    const capital = map.get(key(CAPITAL_X, CAPITAL_Y))
    if (!capital || !Array.isArray(capital[4]) || capital[4].length != 3)
        throw new Error(`capitala ${CAPITAL_X}:${CAPITAL_Y} nu a fost gasita in scan (sau nu are 3 linii): ${JSON.stringify(capital)}`)

    // capetele celor 3 linii; cea din mijloc e cea cu distanta laterala mediana fata de dreapta castel -> capitala
    const dx = CAPITAL_X - SX, dy = CAPITAL_Y - SY
    const side = ([x, y]) => (x - SX) * dy - (y - SY) * dx
    const tails = [...capital[4]].sort((a, b) => side(a) - side(b))
    const middleTail = tails[1]

    // mergem inapoi pe lant de la capat pana la prima fortareata deblocata (fara fortareata anterioara)
    const line = []
    const getFortress = ([x, y]) => {
        const ai = map.get(key(x, y))
        // fara asta, o celula lipsa din scan ar arata ca "linia e terminata"
        if (ai?.[0] != AreaType.watchTower)
            throw new Error(`fortareata ${x}:${y} de pe linia de mijloc lipseste din scan`)
        return ai
    }
    let current = getFortress(middleTail)
    while (current[AI_DESTROYED] == 0) {
        line.unshift([current[1], current[2]])
        const prev = current[AI_PREREQ]?.[0]
        if (!prev)
            break
        current = getFortress(prev)
        if (line.length > 50)
            throw new Error("lantul liniei de mijloc pare circular")
    }

    if (line.length > 0) {
        const active = map.get(key(...line[0]))
        console.info(`[Berimond] Linia de mijloc: ${line.length} fortarete ramase, activa ${line[0][0]}:${line[0][1]} ` +
            `(nivel ${active[AI_LEVEL]}, ${active[AI_REMAINING]} atacuri ramase). Ordine: ${line.map(c => c.join(":")).join(" -> ")}`)
    } else
        console.info(`[Berimond] Linia de mijloc e terminata, trec pe fnt`)

    return line
}

// verifica fortareata activa pe harta: "active", "destroyed", "locked" (lista nu mai corespunde)
// sau "noResponse" (serverul nu a spus nimic despre ea - nu inseamna ca e distrusa)
async function checkFortress(kingdomID, x, y) {
    const r = await rawGaa(kingdomID, Math.max(0, x - 2), Math.max(0, y - 2), x + 2, y + 2)
    const ai = r.AI.find(ai => ai[0] == AreaType.watchTower && ai[1] == x && ai[2] == y)
    if (!ai)
        return { state: "noResponse" }
    if (ai[AI_DESTROYED] == 1)
        return { state: "destroyed" }
    if (ai[AI_PREREQ]?.length > 0)
        return { state: "locked" }
    return { state: "active", remaining: ai[AI_REMAINING] }
}

events.on("load", async () => {
    const kingdomID = KingdomID.berimond

    // datele contului (inclusiv castelul din Berimond) pot sosi cu intarziere fata de "load" -
    // reincercam cateva minute inainte sa renuntam, in loc sa oprim plugin-ul definitiv la primul esec
    let castle
    for (let attempt = 0; attempt < 24 && !castle; attempt++) {
        if (attempt > 0)
            await new Promise(r => setTimeout(r, 5000))

        castle = castles.find(e => e.kingdomID == kingdomID &&
            [AreaType.mainCastle, AreaType.externalKingdom, AreaType.beriCastle].includes(e.areaInfo?.type))
    }

    if (!castle)
        return console.error(`[Berimond] No castle found for kingdomID ${kingdomID} at startup`)

    const SX = castle.areaInfo.x
    const SY = castle.areaInfo.y

    // lista fortaretelor ramase pe linia de mijloc; undefined = trebuie (re)scanata, [] = linia e terminata
    let middleLine
    let lastVerified = 0
    let needsVerify = false // setat cand cra pe linia de mijloc da eroare
    let noResponses = 0
    let botHalted = false // MISSING_UNITS opreste tot botul (haltBot), nu se mai trimite nimic pana la repornire

    // unitatea din inventarul Berimond; undefined = inventarul nu e cunoscut inca
    function berimondTroops() {
        const inventories = castles.filter(e => e.kingdomID == kingdomID && e.unitInventory).map(e => e.unitInventory)
        if (inventories.length == 0)
            return undefined
        return inventories.map(i => i.find(u => u.unitInfo?.wodID == UNIT_WODID) ?? { amount: 0 })
            .reduce((a, b) => b.amount > a.amount ? b : a)
    }

    // nu trimitem atacuri fara trupe: serverul ar raspunde MISSING_UNITS si s-ar opri tot botul
    async function waitForTroops() {
        let lastRefresh = Date.now()
        let logged = false
        while (!botHalted) {
            const troops = berimondTroops()
            if (!troops || troops.amount >= UNIT_AMOUNT) {
                if (logged)
                    console.info(`[Berimond] Am din nou trupe (${troops?.amount}), continui atacurile`)
                return
            }
            if (!logged) {
                console.info(`[Berimond] Doar ${troops.amount} trupe in Berimond (trebuie ${UNIT_AMOUNT}), astept`)
                logged = true
            }
            if (Date.now() - lastRefresh >= TROOP_REFRESH_MS) {
                lastRefresh = Date.now()
                await sendXT("dcl", JSON.stringify({ CD: 1 }))
            }
            await new Promise(r => setTimeout(r, TROOP_POLL_MS))
        }
    }

    // alege ținta: prima fortareata din lista liniei de mijloc, sau fnt cand linia e terminata
    async function pickTarget() {
        while (middleLine === undefined || middleLine.length > 0) {
            if (middleLine === undefined) {
                middleLine = await scanMiddleLine(kingdomID, SX, SY)
                lastVerified = Date.now()
                needsVerify = false
                continue
            }

            const [x, y] = middleLine[0]

            // fara cereri in plus cat timp atacurile merg
            if (!needsVerify && Date.now() - lastVerified < VERIFY_INTERVAL_MS)
                return { X: x, Y: y, source: "mijloc" }

            const check = await checkFortress(kingdomID, x, y)
            if (check.state == "noResponse") {
                // pastram fortareata: urmatoarea din lant e blocata pana cade asta
                needsVerify = true
                if (++noResponses >= 3) {
                    noResponses = 0
                    middleLine = undefined
                }
                throw Object.assign(new Error(`fara raspuns despre ${x}:${y}, reincerc`), { noResponse: true })
            }

            noResponses = 0
            lastVerified = Date.now()
            needsVerify = false
            if (check.state == "active") {
                console.info(`[Berimond] Verificare ${x}:${y}: inca activa, ${check.remaining} atacuri ramase`)
                return { X: x, Y: y, remaining: check.remaining, source: "mijloc" }
            }

            if (check.state == "destroyed") {
                console.info(`[Berimond] Fortareata ${x}:${y} de pe linia de mijloc a fost distrusa, o scot din lista`)
                middleLine.shift()
                continue
            }

            console.warn(`[Berimond] Fortareata ${x}:${y} apare blocata, rescanez linia de mijloc`)
            middleLine = undefined
            await new Promise(r => setTimeout(r, 2000))
        }

        await sendXT("fnt", JSON.stringify({}))
        const [target, fntResult] = await waitForResult("fnt", 1000 * 10, () => true)

        if (fntResult != 0)
            throw err[fntResult] ?? new Error(`fnt failed with result ${fntResult}`)

        if (!target?.gaa)
            throw new Error(`fnt returned no target (chain might be complete)`)

        // in gaa poate lipsi obiectul (AI gol), de aceea verificam si coordonatele
        const isCapital = (target.X == CAPITAL_X && target.Y == CAPITAL_Y) ||
            target.gaa.AI?.some(ai => ai[0] == CAPITAL_TYPE && ai[1] == target.X && ai[2] == target.Y)
        if (isCapital)
            throw Object.assign(new Error(`fnt a dat capitala ${target.X}:${target.Y}`), { capitalReached: true })

        return { X: target.X, Y: target.Y, source: "fnt" }
    }

    while (true) {
        await waitForTroops()
        const commander = await waitForCommanderAvailable(pluginOptions.commanderWhiteList)
        let target
        try {
            const result = await waitToAttack(async () => {
                target = await pickTarget()
                const toolAmount = target.source == "mijloc" ? TOOL_AMOUNT_MIDDLE : TOOL_AMOUNT_OTHER

                const attackTarget = {
                    SX,
                    SY,
                    TX: target.X,
                    TY: target.Y,
                    KID: kingdomID,
                    LID: commander.lordID,
                    WT: 0,
                    HBW: -1,
                    BPC: 0,
                    ATT: 0,
                    AV: 0,
                    LP: 0,
                    FC: 0,
                    PTT: 1,
                    SD: 0,
                    ICA: 0,
                    CD: 99,
                    A: [{
                        L: FLANK == "L" ? loadedFlank(toolAmount) : emptyFlank(),
                        R: FLANK == "R" ? loadedFlank(toolAmount) : emptyFlank(),
                        M: FLANK == "M" ? loadedFlank(toolAmount) : emptyFlank()
                    }],
                    BKS: [],
                    AST: [-1, -1, -1],
                    RW: [[-1, 0], [-1, 0], [-1, 0], [-1, 0], [-1, 0], [-1, 0], [-1, 0], [-1, 0]],
                    ASCT: 0
                }

                await sendXT("cra", JSON.stringify(attackTarget))

                const [obj, result] = await waitForResult("cra", 1000 * 10, (obj, result) => {
                    if (result != 0)
                        return true
                    if (obj.AAM.M.KID != kingdomID || obj.AAM.M.TA[1] != target.X || obj.AAM.M.TA[2] != target.Y)
                        return false
                    return true
                })

                if (result != 0) {
                    if (err[result] == "MISSING_UNITS") {
                        botHalted = true
                        console.warn("[Berimond] Fara trupe (MISSING_UNITS): botul e oprit pana la repornire")
                    }
                    else if (target.source == "mijloc" && !UNRELATED_ERRORS.includes(err[result])) {
                        // poate fortareata a fost distrusa - o verificam pe harta inainte de urmatorul atac
                        console.warn(`[Berimond] cra pe ${target.X}:${target.Y} (mijloc) a dat eroarea ${result} (${err[result] ?? "?"}), verific fortareata`)
                        needsVerify = true
                    }
                    throw err[result] ?? new Error(`cra failed with result ${result}`)
                }

                // cra nu scade trupele din inventarul local
                const troops = berimondTroops()
                if (troops)
                    troops.amount = Math.max(0, troops.amount - UNIT_AMOUNT)

                return obj
            })

            const remaining = target.remaining != undefined ? `, ${target.remaining} atacuri ramase` : ""
            console.info(`[Berimond] Hitting target ${result.AAM.M.TA[1]}:${result.AAM.M.TA[2]} (${target.source}, ${target.source == "mijloc" ? TOOL_AMOUNT_MIDDLE : TOOL_AMOUNT_OTHER} unelte${remaining})`)
        } catch (e) {
            if (e == "LORD_IS_USED")
                onLordIsUsed(commander.lordID)
            else
                freeCommander(commander.lordID)

            if (e?.capitalReached)
                return console.info("[Berimond] Am ajuns la capitala, nu o atac. Opresc atacurile din Berimond")

            console.warn("[Berimond] ", e)
            await new Promise(r => setTimeout(r, e?.noResponse ? NO_RESPONSE_DELAY_MS : 5000))
        }
    }
})
