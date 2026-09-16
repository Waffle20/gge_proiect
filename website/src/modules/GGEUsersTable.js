import * as React from 'react'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Paper from '@mui/material/Paper'
import Button from '@mui/material/Button'
import Backdrop from '@mui/material/Backdrop'
import Checkbox from '@mui/material/Checkbox'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import LogoutIcon from '@mui/icons-material/Logout'

import { ErrorType, ActionType, LogLevel } from "../types.js"
import UserSettings from './userSettings'
import settings from '../settings.json'
import { Grid } from '@mui/material'

function Log({ ws, __ }) {
    const [currentLogs, setCurrentLogs] = React.useState([])

    React.useEffect(() => {
        const logGrabber = msg => {
            let [err, action, obj] = JSON.parse(msg.data.toString())

            if (Number(action) !== ActionType.GetLogs)
                return

            if (Number(err) !== ErrorType.Success)
                return

            setCurrentLogs(obj[0].splice(obj[1], obj[0].length - 1).concat(obj[0]).map((obj, index) => {
                let items = obj[1].map(__).join("")
                return <div key={index} style={{
                    color: obj[0] === LogLevel.Error ? "red" :
                        obj[0] === LogLevel.Warn ? "yellow" : "blue"
                }}>{items}</div>
            }
            ).reverse())
        }
        ws.addEventListener("message", logGrabber)
        return () => ws.removeEventListener("message", logGrabber)

    }, [ws, __])

    return (
        <Paper sx={{ overflow: 'auto' }}>
            <div onClick={e => e.stopPropagation()} style={{maxHeight:"80vh",maxWidth:"80vw"}}>
                <Typography variant="subtitle1" component="div" align='left' padding={"10px"}>
                    {currentLogs}
                </Typography>
            </div>
        </Paper>)
}
function Language({ languageCode, setLanguage }) {
    const [anchorEl, setAnchorEl] = React.useState(null)
    const open = Boolean(anchorEl)
    const handleClick = event => { setAnchorEl(event.currentTarget) }
    const handleClose = () => { setAnchorEl(null) }

    return (
        <>
            <Button
                id="basic-button"
                aria-controls={open ? 'basic-menu' : undefined}
                aria-haspopup="true"
                aria-expanded={open ? 'true' : undefined}
                onClick={handleClick}
            >
                {languageCode}
            </Button>
            <Menu
                id="basic-menu"
                anchorEl={anchorEl}
                open={open}
                onClose={handleClose}
                slotProps={{
                    list: {
                        'aria-labelledby': 'basic-button',
                    },
                }}
            >
                <MenuItem onClick={() => { setLanguage('en'); handleClose() }}>EN</MenuItem>
                <MenuItem onClick={() => { setLanguage('pl'); handleClose() }}>PL</MenuItem>
                <MenuItem onClick={() => { setLanguage('de'); handleClose() }}>DE</MenuItem>
                <MenuItem onClick={() => { setLanguage('tr'); handleClose() }}>TR</MenuItem>
                <MenuItem onClick={() => { setLanguage('ar'); handleClose() }}>AR</MenuItem>
                <MenuItem onClick={() => { setLanguage('cs'); handleClose() }}>CS</MenuItem>
            </Menu>
        </>
    )
}

const assets = 
    JSON.parse(await (await fetch(`//${window.location.hostname}:${settings.port ?? window.location.port}/assets.json`)).text())

function Resources({ __, openResources: resources, languageCode }) {
    if(!resources)
        return <></>
    
    delete resources["coins"]
    delete resources["rubies"]

    const nameOverrides = {
        screws: "component1",
        blackPowder: "component2",
        saws: "component3",
        drills: "component4",
        crowbars: "component5",
        leatherStrips: "component6",
        chains: "component7",
        metalPlates: "component8",
    }
    for (const key in nameOverrides) {
        const value = resources[key]
        if(value) {
            resources[nameOverrides[key]] = value
            delete resources[key]
        }
    }
    for (const key in resources) {
        if([undefined, 0, null].includes(resources[key])) {
            delete resources[key]
            continue
        }
        if (Number(resources[key])) {
            const skipOverrides = {
                "1MinSkip": 1,
                "5MinSkip": 5,
                "10MinSkip": 10,
                "30MinSkip": 30,
                "60MinSkip": 1,
                "5HourSkip": 5,
                "24HourSkip": 24,
            }
            const value = skipOverrides[key]
            resources[key] = `${value? `${value}x` : ""}${new Intl.NumberFormat(languageCode, { notation: 'compact' }).format(resources[key])}`
        }
    }
    const capitalizeFirstLetter = o =>
         String(o).charAt(0).toLocaleUpperCase() + String(o).slice(1)
    
    return (
        <Paper sx={{ overflow: 'auto' }}>
            <div onClick={e => e.stopPropagation()} style={{maxHeight:"80vh",maxWidth:"80vw",}}>
                <Grid container spacing={3} borderColor={"#323"} margin={"16px"}>
                    {
                        Object.entries(resources).map(([key, value], i) => {
                            const jsonKey = capitalizeFirstLetter(key)
                            return <Grid key={i}>
                                <div style={{ 
                                    justifyContent: "center", 
                                    display: "flex", 
                                    flexDirection:"column",  
                                    alignItems:"center",
                                    backgroundColor: "#211f1fff" }}>
                                    <div style={{ maxHeight: "32px", maxWidth: "32px", overflowWrap: "break-word"}}>
                                        <img alt="" onError={(e) => {
                                            e.currentTarget.outerHTML = `<div style="overflow:hidden;max-height:100%;max-width:100%">${__(key)}</div>`
                                        }} style={{ maxHeight: "100%", maxWidth: "100%"}} src={`//${window.location.hostname}:${settings.port ?? window.location.port}/ggeProxyEmpire5/default/assets/${assets[`Collectable_Currency_${jsonKey}`]}.webp`}></img>
                                    </div>
                                    <Typography variant="subtitle1" component="div" align='center' paddingTop={"16px"}>
                                        {value}
                                    </Typography>
                                </div>
                            </Grid>
                            })
                    }
                </Grid>
            </div>
        </Paper>
    )
}
function PlayerTable({ setLanguage, __, languageCode, rows, usersStatus, ws, channelInfo, handleSettingsOpen, handleLogOpen, setSelectedUser, setOpenSettings, handleResourcesOpen }) {
    const [selected, setSelected] = React.useState([])
    const handleSelectAllClick = event => {
        if (event.target.checked) {
            const newSelected = rows.map(n => n.id)
            setSelected(newSelected)
            return
        }
        setSelected([])
    }
    const logout = () => {
        document.cookie = "uuid="
        window.location.reload()
    }

    return <TableContainer component={Paper}>
        <Table sx={{ minWidth: 650 }} aria-label="simple table">
            <TableHead>
                <TableRow>
                    <TableCell padding="checkbox">
                        <Checkbox
                            color="primary"
                            checked={rows.length === selected.length}
                            onClick={handleSelectAllClick}
                            inputProps={{
                                'aria-label': 'select all entries',
                            }}
                        />
                    </TableCell>
                    <TableCell align="left">{__("name")}</TableCell>
                    <TableCell align="left" padding='none'>{__("plugins")}</TableCell>
                    <TableCell>{__("status")}</TableCell>
                    <TableCell align='right' padding='none' style={{ width: "max-content" }}>
                        <Language setLanguage={setLanguage} languageCode={languageCode} />
                        <Button
                            style={{ margin: "10px", maxHeight: '32px', minHeight: '32px' }}
                            onClick={async () =>
                                window.open(`https://discord.com/oauth2/authorize?client_id=${channelInfo[0]}&permissions=8&response_type=code&redirect_uri=${window.location.protocol === 'https:' ? "https" : "http"}%3A%2F%2F${window.location.hostname}%3A${(settings.port ?? window.location.port) !== '' ? (settings.port ?? window.location.port) : window.location.protocol === 'https:' ? "443" : "80"}%2FdiscordAuth&integration_type=0&scope=identify+guilds.join+bot`, "_blank")}
                        >{__("linkDiscord")}</Button>
                        
                        <Button style={{ maxWidth: '64px', maxHeight: '32px', minWidth: '32px', minHeight: '32px', marginRight: "10px" }} onClick={logout}><LogoutIcon/></Button>
                        <Button style={{ maxWidth: '64px', maxHeight: '32px', minWidth: '32px', minHeight: '32px', marginRight: "10px" }} onClick={handleSettingsOpen}>+</Button>
                    </TableCell>
                </TableRow>
            </TableHead>
            <TableBody>
                {rows.map((row, index) => {
                    function PlayerRow() {
                        let getEnabledPlugins = () => {
                            let enabledPlugins = []
                            Object.entries(row.plugins).forEach(([key, value]) => {
                                if (Boolean(value.state) === true && Boolean(value.forced) !== true)
                                    enabledPlugins.push(key)
                                return
                            })
                            return enabledPlugins
                        }

                        const isItemSelected = selected.includes(row.id)
                        const labelId = `enhanced-table-checkbox-${index}`
                        const [state, setState] = React.useState(row.state)
                        row.state = state

                        let status = usersStatus[row.id] ?? {}

                        return (<TableRow style={status?.hasError ? { border: "red solid 2px" } : {}}
                            sx={{ '&:last-child td, &:last-child th': { border: 0 } }}
                        >
                            <TableCell padding="checkbox">
                                <Checkbox
                                    color="primary"
                                    checked={isItemSelected}
                                    onClick={() => {
                                        let index = selected.indexOf(row.id)
                                        if (index < 0) {
                                            selected.push(row.id)
                                            setSelected(Array.from(selected))
                                            return
                                        }
                                        setSelected(selected.toSpliced(index, 1))
                                    }}
                                    inputProps={{
                                        'aria-labelledby': labelId,
                                    }}
                                />
                            </TableCell>
                            <TableCell component="th" scope="row">{row.name}</TableCell>

                            <TableCell align="left" padding='none' sx={{ scrollbarColor: "#5e6269 #2d2f31", scrollbarWidth: "thin", maxWidth: "20vw", overflow: "auto", whiteSpace: "nowrap" }}>
                                {getEnabledPlugins().map(__).join(" ")}
                            </TableCell>
                            <TableCell>
                                <Box sx={{ display: 'flex'}}> {
                                    Object.entries(status).map(([key, value], index) => {
                                        if (['id', 'hasError'].includes(key))
                                            value = undefined
                                        
                                        return <Box key={index} sx={{ display: 'flex', flexDirection: "column", paddingRight: "10px" }}>
                                            <Typography>{value > 0 ? __(key) : ""}</Typography>
                                            <Typography>{value > 0 ? key === "attackDailyCount" ? value : new Intl.NumberFormat(languageCode, { notation: 'compact' }).format(value) : ""}</Typography>
                                        </Box>
                                    })
                                }
                                </Box>
                            </TableCell>
                            <TableCell align="right" padding='none' style={{ padding: "10px" }}>
                                <Button variant="text" onClick={() => {
                                    handleResourcesOpen(status)
                                }}>{__("resources")}</Button>
                                <Button variant="text" onClick={() => {
                                    ws.send(JSON.stringify([ErrorType.Success, ActionType.GetLogs, row]))
                                    handleLogOpen()
                                }}>{__("logs")}</Button>
                                <Button variant="text" onClick={() => {
                                    setSelectedUser(row)
                                    setOpenSettings(true)
                                }}>{__("settings")}</Button>
                                <Button
                                    onClick={() => {
                                        row.state = !state
                                        ws.send(JSON.stringify([ErrorType.Success, ActionType.SetUser, row]))
                                        setState(!state)
                                    }}
                                    variant={state ? "contained" : "outlined"}
                                    color={state ? "error" : "success" }
                                    style={{ maxWidth: '64px', maxHeight: '32px', minWidth: '32px', minHeight: '32px', marginLeft: "10px" }}>{state ? __("stop") : __("start")}</Button>
                            </TableCell>
                        </TableRow>)
                    }
                    return <PlayerRow key={row.id} />
                })}
                <TableRow
                    sx={{ '&:last-child td, &:last-child th': { border: 0 } }}
                >
                    <TableCell align='right' padding='none' />
                    <TableCell align='right' padding='none' />
                    <TableCell align='right' padding='none' />
                    <TableCell align='right' padding='none' />
                    <TableCell align='right' padding='none'>
                        <Button 
                        variant="text" 
                        style={{ 
                            maxWidth: '64px', 
                            maxHeight: '32px', 
                            minWidth: '32px', 
                            minHeight: '32px', 
                            paddingLeft: "38px", 
                            paddingRight: "38px", 
                            margin: "10px" 
                        }} onClick={() => {
                            ws.send(JSON.stringify([ErrorType.Success, ActionType.RemoveUser, rows.filter((e) => selected.includes(e.id))]))
                        }}>{__("remove")}</Button>
                    </TableCell>
                </TableRow>
            </TableBody>
        </Table></TableContainer>
}
export default function GGEUserTable({ setLanguage, __, languageCode, rows, usersStatus, ws, channelInfo, plugins }) {
    const user = {}

    const [openSettings, setOpenSettings] = React.useState(false)
    const [selectedUser, setSelectedUser] = React.useState(user)
    const [openLogs, setOpenLogs] = React.useState(false)
    const [openResources, setOpenResources] = React.useState(false)

    const handleSettingsOpen = () => setOpenSettings(true)
    const handleSettingsClose = () => {
        setOpenSettings(false)
        setSelectedUser(user)
    }

    const handleLogClose = () => setOpenLogs(false)
    const handleLogOpen = () => setOpenLogs(true)
    const handleResourcesClose = () => setOpenResources(false)
    const handleResourcesOpen = (status) => setOpenResources(status.resources)
    return (
        <>
            <Backdrop
                sx={theme => ({ color: '#fff', zIndex: theme.zIndex.drawer + 1 })}
                open={openSettings}
                onClick={handleSettingsClose}
                style={{ maxHeight: '100%', overflow: 'auto' }}
                key={selectedUser.id} >
                <UserSettings ws={ws}
                    selectedUser={selectedUser}
                    key={selectedUser.id}
                    closeBackdrop={handleSettingsClose}
                    plugins={plugins}
                    channels={channelInfo[1]}
                    __={__} />
            </Backdrop>
            <Backdrop
                sx={theme => ({ color: '#fff', zIndex: theme.zIndex.drawer + 1 })}
                open={openLogs}
                onClick={() => {
                    ws.send(JSON.stringify([ErrorType.Success, ActionType.GetLogs, undefined]))

                    handleLogClose()
                }}
                style={{ maxHeight: '100%', overflow: 'auto' }} >
                <Log ws={ws} __={__} />
            </Backdrop>
            <Backdrop
                sx={theme => ({ color: '#fff', zIndex: theme.zIndex.drawer + 1 })}
                open={openResources !== false}
                onClick={() => {
                    handleResourcesClose()
                }}
                style={{ maxHeight: '100%', overflow: 'auto' }} >
                <Resources usersStatus={usersStatus} __={__}  openResources={openResources} languageCode={languageCode}/>
            </Backdrop>
            <PlayerTable
                setLanguage={setLanguage}
                __={__}
                languageCode={languageCode}
                rows={rows}
                usersStatus={usersStatus}
                ws={ws}
                channelInfo={channelInfo}
                handleSettingsOpen={handleSettingsOpen}
                handleLogOpen={handleLogOpen}
                handleResourcesOpen={handleResourcesOpen}
                setSelectedUser={setSelectedUser}
                setOpenSettings={setOpenSettings}
                plugins={plugins}
            />
        </>
    )
}