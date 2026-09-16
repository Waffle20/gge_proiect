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

const { castles, AreaType, KingdomID } = require("../../protocols.js")
const { waitToAttack } = require("./attack.js")
const { waitForCommanderAvailable, freeCommander } = require("../commander.js")
const { sendXT, waitForResult, botConfig, events } = require("../../ggeBot.js")
const err = require("../../err.json")

const pluginOptions = botConfig.plugins[require("path").basename(__filename).slice(0, -3)] ?? {}

// --- Compoziția atacului, editabilă direct aici ---
const UNIT_WODID = 10
const UNIT_AMOUNT = 32
const TOOL_WODID = 620
const TOOL_AMOUNT = 30
const FLANK = "L" // "L" = stanga, "R" = dreapta, "M" = mijloc

const emptyFlank = () => ({ T: [], U: [] })
const loadedFlank = () => ({ T: [[TOOL_WODID, TOOL_AMOUNT]], U: [[UNIT_WODID, UNIT_AMOUNT]] })

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

    while (true) {
        const commander = await waitForCommanderAvailable(pluginOptions.commanderWhiteList)
        try {
            const result = await waitToAttack(async () => {
                await sendXT("fnt", JSON.stringify({}))
                const [target, fntResult] = await waitForResult("fnt", 1000 * 10, () => true)

                if (fntResult != 0)
                    throw err[fntResult] ?? new Error(`fnt failed with result ${fntResult}`)

                if (!target?.gaa)
                    throw new Error(`fnt returned no target (chain might be complete)`)

               // console.log(`[DEBUG-BERIMOND] attacking ${target.X}:${target.Y} in kingdom ${kingdomID}, from castle ${SX}:${SY}`)

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
                        L: FLANK == "L" ? loadedFlank() : emptyFlank(),
                        R: FLANK == "R" ? loadedFlank() : emptyFlank(),
                        M: FLANK == "M" ? loadedFlank() : emptyFlank()
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

                if (result != 0)
                    throw err[result] ?? new Error(`cra failed with result ${result}`)

                return obj
            })

            console.info(`[Berimond] Hitting target ${result.AAM.M.TA[1]}:${result.AAM.M.TA[2]}`)
        } catch (e) {
            freeCommander(commander.lordID)
            console.warn("[Berimond] ", e)
            await new Promise(r => setTimeout(r, 5000))
        }
    }
})
