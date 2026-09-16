if (require("node:worker_threads").isMainThread)
    return module.exports = {
        pluginOptions: [
            {
                type: "Text",
                key: "commanderWhiteList",
                default: "1-99"
            },
            {
                type: "Text",
                key: "targetX",
                default: "634"
            },
            {
                type: "Text",
                key: "targetY",
                default: "821"
            }
        ]
    }

const pretty = require("pretty-time")
const { spendSkip } = require("../skips.js")
const { movementEvents, castles, AreaType, KingdomID, ClientCommands } = require("../../protocols")
const {
    waitToAttack,
    getAttackInfo,
    assignUnit,
    getTotalAmountToolsFlank,
    getTotalAmountToolsFront,
    getAmountSoldiersFlank,
    getAmountSoldiersFront,
    getMaxUnitsInReinforcementWave } = require("./attack")
const { waitForCommanderAvailable, freeCommander, useCommander } = require("../commander")
const { sendXT, waitForResult, playerInfo, botConfig, events } = require("../../ggeBot.js")

const err = require("../../err.json")

const pluginOptions = botConfig.plugins[require("path").basename(__filename).slice(0, -3)] ?? {}

const kingdomID = KingdomID.greatEmpire
const type = AreaType.daimyoCastle
const minTroopCount = 100

const MAIN_TROOP_WODID = 216
const REINFORCEMENT_TROOP_WODID = 215
const WALL_TOOL_WODID = 649
const EXTRA_TOOL_WODID = 651
const MIDDLE_EXTRA_TOOL_WODID = 648

const FIXED_LEVEL = 100

const skipTarget = async areaInfo => {
    console.log(`[DEBUG-DAIMYO] skip check - extraData[2]: ${areaInfo.extraData[2]}`)

    while (areaInfo.extraData[2] > 0) {
        let skip = spendSkip(areaInfo.extraData[2])

        if (skip == undefined)
            throw new Error("couldntFindSkip")

        const { result } = await ClientCommands.skipTarget(type, areaInfo.x, areaInfo.y, kingdomID, skip)

        console.log(`[DEBUG-DAIMYO] skip trimis - skip: ${JSON.stringify(skip)}, result: ${result}`)

        if (result != 0)
            break
    }
}

events.once("load", async () => {
    const castle = castles.find(e => e.kingdomID == kingdomID && e.areaInfo?.type == AreaType.mainCastle)

    if (!castle)
        return console.error("[Daimyo] No Great Empire castle found")

    let lastAttackSentTime = 0
    const lordAvailableAt = new Map()

    while (true) {
        const acquireStart = Date.now()
        const commander = await waitForCommanderAvailable(pluginOptions.commanderWhiteList)
        const acquireDuration = Date.now() - acquireStart

        const availableAt = lordAvailableAt.get(commander.lordID) ?? 0
        if (Date.now() < availableAt)
            await new Promise(r => setTimeout(r, availableAt - Date.now()))

        if (acquireDuration > 1000)
            await new Promise(r => setTimeout(r, 6000))

        try {
            const attackInfo = await waitToAttack(async () => {
                const TARGET_X = Number(pluginOptions.targetX)
                const TARGET_Y = Number(pluginOptions.targetY)

                const areaInfo = (await ClientCommands.getAreaInfo(kingdomID,
                    TARGET_X - 5, TARGET_Y - 5, TARGET_X + 5, TARGET_Y + 5))
                    .areaInfo.find(ai => ai.type == type && ai.x == TARGET_X && ai.y == TARGET_Y)

                if (!areaInfo)
                    throw new Error(`Daimyo target not found at ${TARGET_X}:${TARGET_Y}`)

                await skipTarget(areaInfo)

                await sendXT("adi", JSON.stringify({ SX: castle.areaInfo.x, SY: castle.areaInfo.y, TX: TARGET_X, TY: TARGET_Y, KID: kingdomID }))
                const [, adiResult] = await waitForResult("adi", 1000 * 10, () => true)

                if (adiResult != 0)
                    throw err[adiResult] ?? new Error(`adi failed with result ${adiResult}`)

                const level = FIXED_LEVEL

                const findUnitPool = wodID => {
                    const unit = castle.unitInventory.find(u => u.unitInfo.wodID == wodID && u.amount > 0)
                    return unit ? [unit] : []
                }

                const mainTroops = findUnitPool(MAIN_TROOP_WODID)
                const reinforcementTroops = findUnitPool(REINFORCEMENT_TROOP_WODID)
                const flankTroops = [...mainTroops, ...reinforcementTroops]
                const wallTools = findUnitPool(WALL_TOOL_WODID)
                const extraTools = findUnitPool(EXTRA_TOOL_WODID)
                const middleExtraTools = findUnitPool(MIDDLE_EXTRA_TOOL_WODID)

                let allTroopCount = 0
                mainTroops.forEach(e => allTroopCount += e.amount)

                if (allTroopCount < minTroopCount)
                    throw "NO_MORE_TROOPS"

                const commanderStats = commander.getEffects()
                const attackInfo = getAttackInfo(kingdomID, castle, areaInfo, commander, level, undefined, { useFeather: true }, commanderStats.additionalWaves)

                const maxToolsFlank = getTotalAmountToolsFlank(level, 0)
                const maxToolsFront = getTotalAmountToolsFront(level)
                const maxTroopFront = getAmountSoldiersFront(level, commanderStats.attackUnitAmountFront)
                const maxTroopFlank = getAmountSoldiersFlank(level, commanderStats.attackUnitAmountFlank)

                attackInfo.A.forEach(wave => {
                    const toolBudgetLR = Math.floor(maxToolsFlank / 2)
                    wave.L.T.forEach((unitSlot, i) =>
                        assignUnit(unitSlot, i == 0 ? wallTools : extraTools, toolBudgetLR))
                    let maxTroops = maxTroopFlank
                    wave.L.U.forEach(unitSlot =>
                        maxTroops -= assignUnit(unitSlot, flankTroops, maxTroops))

                    wave.R.T.forEach((unitSlot, i) =>
                        assignUnit(unitSlot, i == 0 ? wallTools : extraTools, toolBudgetLR))
                    maxTroops = maxTroopFlank
                    wave.R.U.forEach(unitSlot =>
                        maxTroops -= assignUnit(unitSlot, flankTroops, maxTroops))

                    const toolBudgetM = Math.floor(maxToolsFront / 3)
                    wave.M.T.forEach((unitSlot, i) =>
                        assignUnit(unitSlot, i == 0 ? wallTools : i == 1 ? middleExtraTools : extraTools, toolBudgetM))
                    maxTroops = maxTroopFront
                    wave.M.U.forEach(unitSlot =>
                        maxTroops -= assignUnit(unitSlot, flankTroops, maxTroops))
                })

                let maxReinforcementTroops = getMaxUnitsInReinforcementWave(playerInfo.level, level) + Number(0 | commanderStats.attackUnitAmountReinforcementBonus)
                attackInfo.RW.forEach(unitSlot =>
                    maxReinforcementTroops -= assignUnit(unitSlot, reinforcementTroops, Math.floor(maxReinforcementTroops / 2) - 1))

                const now = Date.now()
                console.log(`[DEBUG-DAIMYO] interval de la ultima trimitere: ${lastAttackSentTime ? now - lastAttackSentTime : "-"}ms | LID cerut: ${commander.lordID}`)
                lastAttackSentTime = now

                await sendXT("cra", JSON.stringify(attackInfo))

                const [obj, result] = await waitForResult("cra", 1000 * 10, (obj, result) => {
                    if (result != 0)
                        return true
                    if (obj.AAM.M.KID != kingdomID || obj.AAM.M.TA[1] != TARGET_X || obj.AAM.M.TA[2] != TARGET_Y)
                        return false
                    return true
                })

                if (result != 0)
                    throw err[result]

                console.log(`[DEBUG-DAIMYO] cra confirmat - LID din raspuns: ${obj.AAM.UM?.L?.ID}, LID cerut: ${commander.lordID}, potrivire: ${Number(obj.AAM.UM?.L?.ID) == commander.lordID}, MID: ${obj.AAM.M.MID}, TT: ${obj.AAM.M.TT}, PT: ${obj.AAM.M.PT}`)

                lordAvailableAt.set(commander.lordID, Date.now() + Number(obj.AAM.M.TT) * 1000 + 27000)

                return obj
            })

            if (!attackInfo) {
                freeCommander(commander.lordID)
                continue
            }

            console.info(`[Daimyo] Hitting target ${attackInfo.AAM.M.TA[1]}:${attackInfo.AAM.M.TA[2]} `, pretty(Math.round(1000000000 * Math.abs(Math.max(0, attackInfo.AAM.M.TT - attackInfo.AAM.M.PT))), "s"), "till impact")
        } catch (e) {
            freeCommander(commander.lordID)
            switch (e) {
                case "NO_MORE_TROOPS":
                    console.log("[Daimyo] Waiting for more troops")
                    await new Promise(resolve => movementEvents.on("return", function self(movement) {
                        if (movement.kingdomID != kingdomID || movement.targetAttack.extraData[0] != castle.id)
                            return

                        movementEvents.off("return", self)
                        resolve()
                    }))
                    break
                case "LORD_IS_USED":
                    useCommander(commander.lordID)
                    await new Promise(r => setTimeout(r, 5000 + Math.random() * 1000))
                    break
                case "COOLING_DOWN":
                case "TIMED_OUT":
                case "MISSING_UNITS":
                case "CANT_START_NEW_ARMIES":
                    break
                default:
                    console.error("[Daimyo]", e)
                    await new Promise(r => setTimeout(r, 5000))
            }
        }
    }
})