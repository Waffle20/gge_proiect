if (require("node:worker_threads").isMainThread)
    return module.exports = {
        pluginOptions: [
            {
                type: "Text",
                key: "maxCapacity",
                default: "320"
            },
            {
                type: "Text",
                key: "commanderCount",
                default: "5"
            },
            {
                type: "Select",
                key: "skipMode",
                selection: [
                    "1x MS5",
                    "2x MS4"
                ],
                default: "0"
            }
        ]
    }

const { castles, ClientCommands, KingdomID, AreaType, KingdomSkipType, setCastle } = require("../protocols.js")
const { botConfig, events, sendXT, waitForResult } = require("../ggeBot.js")

const pluginOptions = botConfig.plugins[require("path").basename(__filename).slice(0, -3)] ?? {}

// --- Editabil direct aici ---
const TROOP_WODID = 10
const MIN_TROOPS = 110 // prag fix, ignora ce e setat pe site
const CHECK_INTERVAL_MS = 30 * 1000 // la cat timp verifica stocul
const SAFETY_BUFFER = 5 // marja suplimentara, ca sa nu lovim exact capacitatea maxima

// "0" = 1x MS5 (skip de 1h), "1" = 2x MS4 - alegere facuta din site (pluginOptions.skipMode)
const sendSkip = async skipType => {
    const result = await ClientCommands.skipResourceTransfer(skipType, KingdomID.berimond, KingdomSkipType.sendTroops)

    if (result != 0)
        console.warn(`[Berimond-Resupply] skip esuat (${skipType}), cod ${result}`)
    else
        console.log(`[Berimond-Resupply] skip aplicat cu succes (${skipType})`)

    return result
}

const skipTroopTransfer = async () => {
    if (Number(pluginOptions.skipMode ?? 0) == 1) {
        await sendSkip("MS4")
        await sendSkip("MS4")
        return
    }

    await sendSkip("MS5")
}

// pozitia castelului din Berimond nu se schimba niciodata (confirmat manual) -
// se cache-uieste o singura data la pornire si se refoloseste ca ancora pentru cautari live
let berimondSX, berimondSY

const berimondCastleTypes = [AreaType.mainCastle, AreaType.externalKingdom, AreaType.beriCastle]

// castles[] nu se completeaza mereu cu areaInfo (vine doar din gcl/fjf/gpc, nimic nu le cere activ) -
// deci cautam live prin gaa (aceeasi comanda pe care o foloseste si clientul din browser) in jurul
// pozitiei cunoscute, ca sa gasim mereu id-ul curent al castelului, indiferent de starea din castles[]
async function findBerimondCastle() {
    const { areaInfo } = await ClientCommands.getAreaInfo(KingdomID.berimond,
        berimondSX - 2, berimondSY - 2, berimondSX + 2, berimondSY + 2)

    const info = areaInfo?.find(ai => berimondCastleTypes.includes(ai.type) && ai.x == berimondSX && ai.y == berimondSY)

    if (!info)
        return undefined

    const id = Number(info.extraData[0])

    let castle = castles.find(e => e.kingdomID == KingdomID.berimond && e.id == id)

    if (!castle) {
        await sendXT("dcl", JSON.stringify({ CD: 1 }))
        await waitForResult("dcl", 1000 * 10, () => true).catch(e => console.warn("[Berimond-Resupply] resync dcl esuat", e))
        castle = castles.find(e => e.kingdomID == KingdomID.berimond && e.id == id)
    }

    return castle
}

async function checkTroops() {
    try {
        const sourceCastle = castles.find(e => e.kingdomID == KingdomID.greatEmpire &&
            [AreaType.mainCastle, AreaType.externalKingdom].includes(e.areaInfo?.type))
        const berimondCastle = await findBerimondCastle()

        if (!sourceCastle || !berimondCastle)
            return console.log(`[DEBUG-BERIMOND-RESUPPLY] castel lipsa - sursa=${!!sourceCastle} berimond=${!!berimondCastle}`)

        const beforeAmount = berimondCastle.unitInventory?.find(u => u.unitInfo.wodID == TROOP_WODID)?.amount ?? 0
       // console.log(`[DEBUG-BERIMOND-RESUPPLY] inventar INAINTE de sincronizare (wodID ${TROOP_WODID}): ${beforeAmount}`)
       // console.log(`[DEBUG-BERIMOND-RESUPPLY] tot inventarul INAINTE:`, JSON.stringify(berimondCastle.unitInventory?.map(u => [u.unitInfo.wodID, u.amount])))

        await setCastle(berimondCastle, async () => {
            const joinResult = await ClientCommands.joinCastle(berimondCastle.id, KingdomID.berimond)
           // console.log(`[DEBUG-BERIMOND-RESUPPLY] joinCastle result: ${joinResult}`)
            if (joinResult != 0)
                console.warn(`[Berimond-Resupply] nu am putut re-sincroniza castelul din Berimond, cod ${joinResult} - folosesc date posibil vechi`)
        })

        //console.log(`[DEBUG-BERIMOND-RESUPPLY] tot inventarul DUPA:`, JSON.stringify(berimondCastle.unitInventory?.map(u => [u.unitInfo.wodID, u.amount])))

        const currentAmount = berimondCastle.unitInventory?.find(u => u.unitInfo.wodID == TROOP_WODID)?.amount ?? 0
        const minTroops = MIN_TROOPS
        const maxCapacity = Number(pluginOptions.maxCapacity ?? 320)

        console.log(`[DEBUG-BERIMOND-RESUPPLY] trupe curente la Berimond (wodID ${TROOP_WODID}): ${currentAmount}, prag minim: ${minTroops}, capacitate maxima: ${maxCapacity}`)

        if (currentAmount >= minTroops)
            return

        const resupplyAmount = Math.max(0, maxCapacity - currentAmount - (Number(pluginOptions.commanderCount ?? 5) * 32) - SAFETY_BUFFER)
        const available = sourceCastle.unitInventory?.find(u => u.unitInfo.wodID == TROOP_WODID)?.amount ?? 0
        const toSend = Math.min(resupplyAmount, available)

        if (toSend <= 0)
            return console.log(`[DEBUG-BERIMOND-RESUPPLY] nu am trupe wodID ${TROOP_WODID} disponibile in Great Empire`)

        const result = await ClientCommands.kingdomTroopTransfer(sourceCastle.id, KingdomID.greatEmpire, KingdomID.berimond, [[TROOP_WODID, toSend]])

        if (result != 0)
            return console.warn(`[Berimond-Resupply] trimitere esuata, cod ${result}`)

        console.log(`[Berimond-Resupply] trimise ${toSend} trupe (wodID ${TROOP_WODID}) spre Berimond`)

        try {
            await skipTroopTransfer()
        }
        catch (e) {
            console.debug(e)
        }
    } catch (e) {
        console.warn("[Berimond-Resupply]", e)
    }
}

events.once("load", async () => {
    // datele contului (inclusiv castelul din Berimond) pot sosi cu intarziere fata de "load" -
    // reincercam cateva minute inainte sa renuntam, in loc sa oprim plugin-ul definitiv la primul esec
    let cached
    for (let attempt = 0; attempt < 24 && !cached; attempt++) {
        if (attempt > 0)
            await new Promise(r => setTimeout(r, 5000))

        cached = castles.find(e => e.kingdomID == KingdomID.berimond && berimondCastleTypes.includes(e.areaInfo?.type))
    }

    if (!cached)
        return console.error(`[Berimond-Resupply] Nu am gasit pozitia initiala a castelului din Berimond, plugin oprit`)

    berimondSX = cached.areaInfo.x
    berimondSY = cached.areaInfo.y

    checkTroops()
    setInterval(checkTroops, CHECK_INTERVAL_MS)
})