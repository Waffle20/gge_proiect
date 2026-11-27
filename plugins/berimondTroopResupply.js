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
const TROOP_WODID = 216 // 2069 lvl archer 10 oroare
const TROOPS_PER_COMMANDER = 32 // trebuie sa fie egal cu UNIT_AMOUNT din attackBerimondFortresses
const MIN_TROOPS = TROOPS_PER_COMMANDER * 2 // sub atat acasa trimitem trupe (ignora ce e setat pe site)
const MIN_SEND = TROOPS_PER_COMMANDER // nu consumam un skip pe mai putin de un atac
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

// doar soldatii ocupa loc in tabara, uneltele (fara "role") nu
const countSoldiers = unitList => Array.from(unitList ?? [])
    .filter(u => u.unitInfo?.role)
    .reduce((sum, u) => sum + u.amount, 0)

let lastTransfer, lastTransferAt = 0
// trupele aflate inca in transfer spre Berimond (daca skip-ul nu a terminat transferul)
function troopsInTransfer(castle) {
    const transfer = castle.troopTransfer
    if (transfer !== lastTransfer) {
        lastTransfer = transfer
        lastTransferAt = Date.now()
    }
    // dupa ce expira timpul, trupele sunt deja numarate acasa
    if (!transfer || !(Date.now() - lastTransferAt < transfer.remainingTime * 1000))
        return 0
    return countSoldiers(transfer.units)
}

const skipTroopTransfer = async () => {
    if (Number(pluginOptions.skipMode ?? 0) == 1) {
        const first = await sendSkip("MS4")
        const second = await sendSkip("MS4")
        return first == 0 && second == 0
    }

    return await sendSkip("MS5") == 0
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

        // locurile ocupate in tabara: soldatii de acasa + cei plecati la atac + cei in transfer
        const home = countSoldiers(berimondCastle.unitInventory)
        const inTransfer = troopsInTransfer(berimondCastle)
        // fara TU in raspuns presupunem, ca inainte, ca toti comandantii sunt plecati cu armata intreaga
        const traveling = berimondCastle.travelingUnits
            ? countSoldiers(berimondCastle.travelingUnits)
            : Number(pluginOptions.commanderCount ?? 5) * TROOPS_PER_COMMANDER
        const resupplyAmount = Math.max(0, maxCapacity - home - traveling - inTransfer - SAFETY_BUFFER)

        console.log(`[DEBUG-BERIMOND-RESUPPLY] wodID ${TROOP_WODID} acasa: ${currentAmount} (prag ${minTroops}) | soldati acasa: ${home}, ` +
            `pe drum: ${traveling}${berimondCastle.travelingUnits ? "" : " (estimat, fara TU)"}, in transfer: ${inTransfer}, ` +
            `capacitate: ${maxCapacity}, loc liber: ${resupplyAmount} | US=${berimondCastle.getProductionData?.maxUnitStorage}`)

        if (currentAmount >= minTroops)
            return

        const sourceTroops = sourceCastle.unitInventory?.find(u => u.unitInfo.wodID == TROOP_WODID)
        const available = sourceTroops?.amount ?? 0
        const toSend = Math.min(resupplyAmount, available)

        if (toSend < MIN_SEND)
            return console.log(`[DEBUG-BERIMOND-RESUPPLY] nu trimit: loc liber ${resupplyAmount}, ` +
                `disponibile in Great Empire ${available}, minim pe transfer ${MIN_SEND}`)

        const result = await ClientCommands.kingdomTroopTransfer(sourceCastle.id, KingdomID.greatEmpire, KingdomID.berimond, [[TROOP_WODID, toSend]])

        if (result != 0)
            return console.warn(`[Berimond-Resupply] trimitere esuata, cod ${result}`)

        // inventarul din Great Empire nu se actualizeaza singur dupa transfer
        sourceTroops.amount -= toSend
        console.log(`[Berimond-Resupply] trimise ${toSend} trupe (wodID ${TROOP_WODID}) spre Berimond`)

        try {
            // transfer terminat: trupele apar acasa la urmatoarea sincronizare, nu le numaram de doua ori
            if (await skipTroopTransfer())
                berimondCastle.troopTransfer = undefined
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