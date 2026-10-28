// Picture-in-picture windows (Chromium, Electron apps like Stremio, Firefox) can't ask to stay
// on top or on all desktops on Wayland, so GNOME treats them like any other window. This makes
// every PiP window "always on top" and "on all desktops" as soon as it appears (without the zoom-in
// animation, and where you last put one of that app's), and right-click on it opens GNOME's
// window menu (as Firefox's PiP does) to change that, move or close it.
// It also tells Firefox right away which of its windows are on another desktop or minimized
// (TikTok PiP for Firefox reads it; Firefox itself only hears it seconds later).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Chromium/Electron: "Picture in picture"; Firefox: "Picture-in-Picture"
const PIP_TITLE = /^picture[\s-]in[\s-]picture$/i;
// Where each app's PiP window was last moved or resized to, by app (window class).
const PLACES = GLib.build_filenamev([GLib.get_user_state_dir(), 'pip-everywhere', 'places.json']);
// Titles of Firefox windows on another desktop or minimized: {"hidden": [...]}.
const HIDDEN = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'pip-everywhere', 'hidden-windows.json']);
const FIREFOX = /firefox/i;

function readJson(path) {
    try {
        return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
    } catch {
        return null;
    }
}

function writeJson(path, value) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, JSON.stringify(value));
}

export default class PipEverywhereExtension extends Extension {
    enable() {
        this._handled = new Set();
        this._watched = new Set();
        this._places = readJson(PLACES) ?? {};
        this._hidden = null;
        this._createdId = global.display.connect('window-created', (d, w) => this._watch(w));
        this._pressId = global.stage.connect('captured-event', (actor, event) => this._onPress(event));
        this._grabId = global.display.connect('grab-op-end', (d, w) => this._remember(w));
        this._workspaceId = global.workspace_manager.connect('active-workspace-changed', () => this._writeHidden());
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
        this._writeHidden();
    }

    disable() {
        global.display.disconnect(this._createdId);
        global.stage.disconnect(this._pressId);
        global.display.disconnect(this._grabId);
        global.workspace_manager.disconnect(this._workspaceId);
        Gio.File.new_for_path(HIDDEN).delete_async(GLib.PRIORITY_DEFAULT, null, null);
        for (const w of this._watched)
            w.disconnectObject(this);
        for (const w of this._handled) {
            if (w.get_compositor_private()) {
                w.unmake_above();
                w.unstick();
            }
        }
        this._handled = this._watched = this._places = null;
    }

    // Right-click on a PiP window: GNOME's window menu instead of the app's (which has none).
    _onPress(event) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const w = [...this._handled].reverse().find(win => {
            const r = win.get_frame_rect();
            return win.showing_on_its_workspace() && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        });
        if (!w)
            return Clutter.EVENT_PROPAGATE;
        Main.wm._windowMenuManager.showWindowMenuForWindow(w, Meta.WindowMenuType.WM,
            {x: Math.round(x), y: Math.round(y), width: 0, height: 0});
        return Clutter.EVENT_STOP;
    }

    _watch(w) {
        // Titles can arrive after the window does.
        this._watched.add(w);
        w.connectObject('notify::title', () => {
            this._apply(w);
            this._writeHidden();
        }, 'notify::minimized', () => this._writeHidden(),
        'workspace-changed', () => this._writeHidden(),
        'unmanaged', () => {
            this._watched?.delete(w);
            this._handled?.delete(w);
            this._writeHidden();
        }, this);
        this._apply(w);
    }

    // The Firefox windows you can't see: minimized, or on another desktop than yours.
    _writeHidden() {
        if (!this._watched)
            return;
        const active = global.workspace_manager.get_active_workspace();
        const hidden = [...this._watched].filter(w => w.window_type === Meta.WindowType.NORMAL &&
            FIREFOX.test(w.get_wm_class() ?? '') && !this._handled.has(w) &&
            (w.minimized || (!w.is_on_all_workspaces() && w.get_workspace() !== active)))
            .map(w => w.get_title() ?? '');
        const json = JSON.stringify(hidden.sort());
        if (json === this._hidden)
            return;
        this._hidden = json;
        try {
            writeJson(HIDDEN, {hidden});
        } catch (e) {
            console.warn(`pip-everywhere: ${e.message}`);
        }
    }

    _key(w) {
        return w.get_wm_class() ?? 'pip';
    }

    // You moved or resized a PiP window: the next one of that app goes there.
    _remember(w) {
        if (!w || !this._handled?.has(w))
            return;
        const {x, y, width, height} = w.get_frame_rect();
        this._places[this._key(w)] = {x, y, width, height};
        try {
            writeJson(PLACES, this._places);
        } catch (e) {
            console.warn(`pip-everywhere: ${e.message}`);
        }
    }

    // GNOME places new windows itself as they first show: put it back where it was, then.
    _restore(w) {
        // A new window may not have its class (the app) yet.
        if (!w.get_wm_class()) {
            const id = w.connect('notify::wm-class', () => {
                w.disconnect(id);
                this._restore(w);
            });
            return;
        }
        const place = this._places[this._key(w)];
        if (!place)
            return;
        const move = () => w.move_resize_frame(true, place.x, place.y, place.width, place.height);
        move();
        // ...and once it's shown, since GNOME may have placed it in between.
        const id = w.connect('shown', () => {
            w.disconnect(id);
            move();
        });
    }

    _apply(w) {
        if (!this._handled || this._handled.has(w) || !PIP_TITLE.test(w.get_title() ?? ''))
            return;
        this._handled.add(w);
        // It just appears, without GNOME's zoom-in. If it isn't on screen yet, its next animation
        // is skipped; if its title came late and the zoom-in has started, it ends right away.
        const actor = w.get_compositor_private();
        if (actor && !actor.mapped)
            Main.wm.skipNextEffect(actor);
        else
            actor?.remove_all_transitions();
        w.make_above();
        w.stick();
        this._restore(w);
        console.log(`pip-everywhere: "${w.get_title()}" kept on top, on all desktops`);
    }
}
