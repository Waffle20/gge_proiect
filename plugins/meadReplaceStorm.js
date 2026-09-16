if (require('node:worker_threads').isMainThread)
    return module.exports = { }

const {
    ClientCommands,
    KingdomSkipType,
    KingdomID,
    AreaType,
    castles,
    unlockInfoList
} = require("../protocols.js")
const { events } = require("../ggeBot.js")

const hoursLeftTillRefilMandatory = 3.1 //was 2.1
const hoursLeftTillRefilWarning = 4.1
const sendResTimeout = 29 * 30 * 1000
const kingdomID = KingdomID.stormIslands

const FIXED_MEAD_SKIP_TYPE = "MS5" // confirmat manual - skip de 1h, drumul Great Empire -> Storm Islands

const skipResource = async () => {
    const result = await ClientCommands.skipResourceTransfer(FIXED_MEAD_SKIP_TYPE, kingdomID, KingdomSkipType.sendResource)

    if (result != 0)
        console.warn("[MeadReplace] skip esuat, cod", result)
    else
        console.log("[MeadReplace] skip aplicat cu succes", FIXED_MEAD_SKIP_TYPE)
}

events.once("load", async () => {
    if(!unlockInfoList.find(e => e.kingdomID == kingdomID)?.isUnlocked)
        return console.warn("wontRunWithoutStormUnlocked")

    // datele contului (inclusiv castelul din Storm Islands) pot sosi cu intarziere fata de "load" -
    // reincercam cateva minute inainte sa renuntam, in loc sa crapam pe date inexistente
    let stormCastle
    for (let attempt = 0; attempt < 24 && !stormCastle; attempt++) {
        if (attempt > 0)
            await new Promise(r => setTimeout(r, 5000))

        stormCastle = castles.find(e => e.kingdomID == kingdomID &&
            e.areaInfo?.type == AreaType.externalKingdom)
    }

    const mainCastle = castles.find(({ kingdomID, areaInfo }) => kingdomID == KingdomID.greatEmpire && areaInfo?.type == AreaType.mainCastle)

    if (!stormCastle || !mainCastle)
        return console.error(`[MeadReplace] Nu am gasit castelul din Storm Islands sau Great Empire, plugin oprit`)

    let checkMead = async () => {
        if (stormCastle.resourceTransfer?.resources?.mead)
            stormCastle.mead += (stormCastle?.resourceTransfer?.resources?.mead ?? 0)

        let meadLossPerHour = stormCastle.mead / stormCastle.getProductionData.MeadConsumptionRate
        let hoursTillRefill = Math.max(0, meadLossPerHour - hoursLeftTillRefilMandatory)

        if (meadLossPerHour == Infinity || isNaN(meadLossPerHour))
            return console.log("dontNeedToSendMead")

        if (stormCastle.getProductionData.maxAmountMead / stormCastle.getProductionData.MeadConsumptionRate < hoursLeftTillRefilWarning)
            console.warn("notEnoughTimeForMeadReplace", hoursLeftTillRefilWarning, "hoursForFoodMeadReplace")

        if (stormCastle.resourceTransfer?.remainingTime >= 
                (stormCastle.mead - (stormCastle.resourceTransfer?.resources?.mead ?? 0)) / stormCastle.getProductionData.MeadConsumptionRate / 60 / 60) { //TODO: Partial Skipping
            await skipResource()
        }
        else
            console.log("dontNeedMeadForAnother", Math.round(hoursTillRefill), "hoursMeadReplace")

        setTimeout(async () => {
            let amount = Math.floor((stormCastle.getProductionData.maxAmountMead - stormCastle.mead))

            let result = await ClientCommands.kingdomUnitTransfer(
                mainCastle.id,
                KingdomID.greatEmpire,
                kingdomID,
                [["MEAD", amount]])
            if (result == 0){
                console.log("sentMeadReplace", amount, "meadToMeadReplace")
                try {
                    await skipResource()
                }
                catch (e) {
                    console.debug(e)
                }
            }  
            else
                console.log("failedToSendMead")
            
            setTimeout(checkMead, sendResTimeout)

        }, Math.min(hoursTillRefill * 60 * 60 * 1000, 2147483647))
    }
    checkMead()
})