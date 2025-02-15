/*
 * SPDX-License-Identifier: GPL-3.0
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 */

import {
    app,
    BrowserWindow,
    BrowserWindowConstructorOptions,
    dialog,
    Menu,
    MenuItemConstructorOptions,
    Tray
} from "electron";
import { rm } from "fs/promises";
import { join } from "path";
import { IpcEvents } from "shared/IpcEvents";
import { isTruthy } from "shared/utils/guards";
import { once } from "shared/utils/once";
import type { SettingsStore } from "shared/utils/SettingsStore";

import { ICON_PATH } from "../shared/paths";
import { createAboutWindow } from "./about";
import { initArRPC } from "./arrpc";
import { DATA_DIR, DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, VENCORD_FILES_DIR } from "./constants";
import { Settings, VencordSettings } from "./settings";
import { createSplashWindow } from "./splash";
import { makeLinksOpenExternally } from "./utils/makeLinksOpenExternally";
import { downloadVencordFiles, ensureVencordFiles } from "./utils/vencordLoader";

let isQuitting = false;
let tray: Tray;

app.on("before-quit", () => {
    isQuitting = true;
});

export let mainWin: BrowserWindow;

function makeSettingsListenerHelpers<O extends object>(o: SettingsStore<O>) {
    const listeners = new Map<(data: any) => void, PropertyKey>();

    const addListener: typeof o.addChangeListener = (path, cb) => {
        listeners.set(cb, path);
        o.addChangeListener(path, cb);
    };
    const removeAllListeners = () => {
        for (const [listener, path] of listeners) {
            o.removeChangeListener(path as any, listener);
        }

        listeners.clear();
    };

    return [addListener, removeAllListeners] as const;
}

const [addSettingsListener, removeSettingsListeners] = makeSettingsListenerHelpers(Settings);
const [addVencordSettingsListener, removeVencordSettingsListeners] = makeSettingsListenerHelpers(VencordSettings);

function initTray(win: BrowserWindow) {
    const trayMenu = Menu.buildFromTemplate([
        {
            label: "Open",
            click() {
                win.show();
            },
            enabled: false
        },
        {
            label: "About",
            click: createAboutWindow
        },
        {
            label: "Update Vencord",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Reset Vesktop",
            async click() {
                await clearData(win);
            }
        },
        {
            type: "separator"
        },
        {
            label: "Relaunch",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Quit Vesktop",
            click() {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray = new Tray(ICON_PATH);
    tray.setToolTip("Vesktop");
    tray.setContextMenu(trayMenu);
    tray.on("click", () => win.show());

    win.on("show", () => {
        trayMenu.items[0].enabled = false;
    });

    win.on("hide", () => {
        trayMenu.items[0].enabled = true;
    });
}

const enum MessageBoxChoice {
    Default,
    Cancel
}

async function clearData(win: BrowserWindow) {
    const { response } = await dialog.showMessageBox(win, {
        message: "Are you sure you want to reset Vesktop?",
        detail: "This will log you out, clear caches and reset all your settings!\n\nVesktop will automatically restart after this operation.",
        buttons: ["Yes", "No"],
        cancelId: MessageBoxChoice.Cancel,
        defaultId: MessageBoxChoice.Default,
        type: "warning"
    });

    if (response === MessageBoxChoice.Cancel) return;

    win.close();

    await win.webContents.session.clearStorageData();
    await win.webContents.session.clearCache();
    await win.webContents.session.clearCodeCaches({});
    await rm(DATA_DIR, { force: true, recursive: true });

    app.relaunch();
    app.quit();
}

function initMenuBar(win: BrowserWindow) {
    const isWindows = process.platform === "win32";
    const isDarwin = process.platform === "darwin";
    const wantCtrlQ = !isWindows || VencordSettings.store.winCtrlQ;

    const subMenu = [
        {
            label: "About Vesktop",
            click: createAboutWindow
        },
        {
            label: "Force Update Vencord",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            },
            toolTip: "Vesktop will automatically restart after this operation"
        },
        {
            label: "Reset Vesktop",
            async click() {
                await clearData(win);
            },
            toolTip: "Vesktop will automatically restart after this operation"
        },
        {
            label: "Relaunch",
            accelerator: "CmdOrCtrl+Shift+R",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        isDarwin && {
            label: "Hide",
            role: "hide"
        },
        isDarwin && {
            label: "Hide others",
            role: "hideOthers"
        },
        {
            label: "Quit",
            accelerator: wantCtrlQ ? "CmdOrCtrl+Q" : void 0,
            visible: !isWindows,
            role: "quit",
            click() {
                app.quit();
            }
        },
        isWindows && {
            label: "Quit",
            accelerator: "Alt+F4",
            role: "quit",
            click() {
                app.quit();
            }
        },
        // See https://github.com/electron/electron/issues/14742 and https://github.com/electron/electron/issues/5256
        {
            label: "Zoom in (hidden, hack for Qwertz and others)",
            accelerator: "CmdOrCtrl+=",
            role: "zoomIn",
            visible: false
        }
    ] satisfies Array<MenuItemConstructorOptions | false>;

    const menu = Menu.buildFromTemplate([
        {
            label: "Vesktop",
            role: "appMenu",
            submenu: subMenu.filter(isTruthy)
        },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" }
    ]);

    Menu.setApplicationMenu(menu);
}

function getWindowBoundsOptions(): BrowserWindowConstructorOptions {
    const { x, y, width, height } = Settings.store.windowBounds ?? {};

    const options = {
        width: width ?? DEFAULT_WIDTH,
        height: height ?? DEFAULT_HEIGHT
    } as BrowserWindowConstructorOptions;

    if (x != null && y != null) {
        options.x = x;
        options.y = y;
    }

    if (!Settings.store.disableMinSize) {
        options.minWidth = MIN_WIDTH;
        options.minHeight = MIN_HEIGHT;
    }

    return options;
}

function initWindowBoundsListeners(win: BrowserWindow) {
    const saveState = () => {
        Settings.store.maximized = win.isMaximized();
        Settings.store.minimized = win.isMinimized();
    };

    win.on("maximize", saveState);
    win.on("minimize", saveState);
    win.on("unmaximize", saveState);

    const saveBounds = () => {
        Settings.store.windowBounds = win.getBounds();
    };

    win.on("resize", saveBounds);
    win.on("move", saveBounds);
}

function initSettingsListeners(win: BrowserWindow) {
    addSettingsListener("tray", enable => {
        if (enable) initTray(win);
        else tray?.destroy();
    });
    addSettingsListener("disableMinSize", disable => {
        if (disable) {
            // 0 no work
            win.setMinimumSize(1, 1);
        } else {
            win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);

            const { width, height } = win.getBounds();
            win.setBounds({
                width: Math.max(width, MIN_WIDTH),
                height: Math.max(height, MIN_HEIGHT)
            });
        }
    });

    addVencordSettingsListener("macosTranslucency", enabled => {
        if (enabled) {
            win.setVibrancy("sidebar");
            win.setBackgroundColor("#ffffff00");
        } else {
            win.setVibrancy(null);
            win.setBackgroundColor("#ffffff");
        }
    });

    addSettingsListener("enableMenu", enabled => {
        win.setAutoHideMenuBar(enabled ?? false);
    });
}

function initSpellCheck(win: BrowserWindow) {
    win.webContents.on("context-menu", (_, data) => {
        win.webContents.send(IpcEvents.SPELLCHECK_RESULT, data.misspelledWord, data.dictionarySuggestions);
    });
}

function createMainWindow() {
    // Clear up previous settings listeners
    removeSettingsListeners();
    removeVencordSettingsListeners();

    const { staticTitle, transparencyOption, enableMenu } = Settings.store;
    const { frameless, macosTranslucency } = VencordSettings.store;
    const win = (mainWin = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            sandbox: false,
            contextIsolation: true,
            devTools: true,
            preload: join(__dirname, "preload.js"),
            spellcheck: true
        },
        icon: ICON_PATH,
        frame: frameless !== true,
        ...(transparencyOption && transparencyOption !== "none"
            ? {
                  backgroundColor: "#00000000",
                  backgroundMaterial: Settings.store.transparencyOption,
                  transparent: true
              }
            : {}),
        ...(staticTitle ? { title: "Vesktop" } : {}),
        ...(macosTranslucency
            ? {
                  vibrancy: "sidebar",
                  backgroundColor: "#ffffff00"
              }
            : {}),
        ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
        ...getWindowBoundsOptions(),
        autoHideMenuBar: enableMenu
    }));
    win.setMenuBarVisibility(false);

    win.on("close", e => {
        const useTray = Settings.store.minimizeToTray !== false && Settings.store.tray !== false;
        if (isQuitting || (process.platform !== "darwin" && !useTray)) return;

        e.preventDefault();

        if (process.platform === "darwin") app.hide();
        else win.hide();

        return false;
    });

    if (Settings.store.staticTitle) win.on("page-title-updated", e => e.preventDefault());

    initWindowBoundsListeners(win);
    if ((Settings.store.tray ?? true) && process.platform !== "darwin") initTray(win);
    initMenuBar(win);
    makeLinksOpenExternally(win);
    initSettingsListeners(win);
    initSpellCheck(win);

    win.webContents.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
    );

    const subdomain =
        Settings.store.discordBranch === "canary" || Settings.store.discordBranch === "ptb"
            ? `${Settings.store.discordBranch}.`
            : "";

    win.loadURL(`https://${subdomain}discord.com/app`);

    return win;
}

const runVencordMain = once(() => require(join(VENCORD_FILES_DIR, "vencordDesktopMain.js")));

export async function createWindows() {
    const splash = createSplashWindow();

    await ensureVencordFiles();
    runVencordMain();

    mainWin = createMainWindow();

    mainWin.once("ready-to-show", () => {
        splash.destroy();
        mainWin!.show();

        if (Settings.store.maximized) {
            mainWin!.maximize();
        }
    });

    initArRPC();
}
