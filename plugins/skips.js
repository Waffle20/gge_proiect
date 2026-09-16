if (require('node:worker_threads').isMainThread)
    return module.exports = {
        pluginOptions: [
            {
                type: "Checkbox",
                key: "bypassSkipTypeFilter",
                default: false
            },
            { type: "Label", key: "skipTypes" },
            {
                type: "Checkbox",
                key: "1Minute",
                default: true
            },
            {
                type: "Checkbox",
                key: "5Minute",
                default: true
            },
            {
                type: "Checkbox",
                key: "10Minute",
                default: true
            },
            {
                type: "Checkbox",
                key: "30Minute",
                default: true
            },
            {
                type: "Checkbox",
                key: "1Hour",
                default: true
            },
            {
                type: "Checkbox",
                key: "5Hour",
                default: true
            },
            {
                type: "Checkbox",
                key: "24Hour",
                default: true
            },
        ],
        force: true
    }

const { botConfig } = require("../ggeBot")
const { resources } = require('../protocols')

const MinuteSkipType = Object.freeze({
    MS1: 1,
    MS2: 5,
    MS3: 10,
    MS4: 30,
    MS5: 60,
    MS6: 60 * 5,
    MS7: 60 * 24
})

const pluginOptions = botConfig.plugins[require("path").basename(__filename).slice(0, -3)] ?? {}

// Sortare unica: intai cine ACOPERA timpul ramas (prioritate reala). Intre cele care
// acopera, preferam cea mai MICA suficienta (nu risipim un skip mare). Intre cele care
// NU acopera, preferam cea mai MARE disponibila, ca sa facem progres maxim per cerere -
// altfel, cand nimic nu acopera integral (cooldown foarte lung), algoritmul risca sa aleaga
// zeci de skip-uri mici la rand doar pentru ca sunt mai abundente in stoc.
const bySkipPriority = time => (a, b) => {
    const aCovers = time <= MinuteSkipType[a[0]]
    const bCovers = time <= MinuteSkipType[b[0]]
    if (aCovers != bCovers)
        return aCovers ? -1 : 1
    if (aCovers)
        return MinuteSkipType[a[0]] - MinuteSkipType[b[0]]
    return MinuteSkipType[b[0]] - MinuteSkipType[a[0]]
}

function haveEnoughSkips(time) {
    const skips = {
        MS1: pluginOptions["1Minute"] ? structuredClone(resources['1MinSkip']) : 0,
        MS2: pluginOptions["5Minute"] ? structuredClone(resources['5MinSkip']) : 0,
        MS3: pluginOptions["10Minute"] ? structuredClone(resources['10MinSkip']) : 0,
        MS4: pluginOptions["30Minute"] ? structuredClone(resources['30MinSkip']) : 0,
        MS5: pluginOptions["1Hour"] ? structuredClone(resources['60MinSkip']) : 0,
        MS6: pluginOptions["5Hour"] ? structuredClone(resources['5HourSkip']) : 0,
        MS7: pluginOptions["24Hour"] ? structuredClone(resources['24HourSkip']) : 0
    }
    time = Math.ceil(time / 60)

    while (time > 0) {
        const skip = Object.entries(skips)
            .filter(e => e[1] > 0)
            .filter(e => pluginOptions.bypassSkipTypeFilter || MinuteSkipType[e[0]] <= time * 4)
            .sort(bySkipPriority(time))

        if (skip[0] == undefined)
            return false

        skips[skip[0][0]]--
        time -= MinuteSkipType[skip[0][0]]
    }
    return true 
}

function spendSkip(time) {
    const skips = {
        MS1: pluginOptions["1Minute"] ? resources['1MinSkip'] : 0,
        MS2: pluginOptions["5Minute"] ? resources['5MinSkip'] : 0,
        MS3: pluginOptions["10Minute"] ? resources['10MinSkip'] : 0,
        MS4: pluginOptions["30Minute"] ? resources['30MinSkip'] : 0,
        MS5: pluginOptions["1Hour"] ? resources['60MinSkip'] : 0,
        MS6: pluginOptions["5Hour"] ? resources['5HourSkip'] : 0,
        MS7: pluginOptions["24Hour"] ? resources['24HourSkip'] : 0
    }
    time = Math.ceil(time / 60)
    const skip = Object.entries(skips)
        .filter(e => e[1] > 0)
        .filter(e => pluginOptions.bypassSkipTypeFilter || MinuteSkipType[e[0]] <= time * 4)
        .sort(bySkipPriority(time))

    if (skip[0] == undefined)
        return console.warn("noMoreSkips")

    console.debug("usingSkip", skip[0][0])

    return skip[0][0]
}

module.exports = { spendSkip, haveEnoughSkips, MinuteSkipType }