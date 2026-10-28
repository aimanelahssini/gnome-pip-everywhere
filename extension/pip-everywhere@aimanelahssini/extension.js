// Picture-in-picture windows (Chromium, Electron apps like Stremio, Firefox) can't ask to stay
// on top or on all desktops on Wayland, so GNOME treats them like any other window. This makes
// every PiP window "always on top" and "on all desktops" as soon as it appears (without the zoom-in
// animation), and right-click
// on it opens GNOME's window menu (as Firefox's PiP does) to change that, move or close it.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Chromium/Electron: "Picture in picture"; Firefox: "Picture-in-Picture"
const PIP_TITLE = /^picture[\s-]in[\s-]picture$/i;

export default class PipEverywhereExtension extends Extension {
    enable() {
        this._handled = new Set();
        this._watched = new Set();
        this._createdId = global.display.connect('window-created', (d, w) => this._watch(w));
        this._pressId = global.stage.connect('captured-event', (actor, event) => this._onPress(event));
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    disable() {
        global.display.disconnect(this._createdId);
        global.stage.disconnect(this._pressId);
        for (const w of this._watched)
            w.disconnectObject(this);
        for (const w of this._handled) {
            if (w.get_compositor_private()) {
                w.unmake_above();
                w.unstick();
            }
        }
        this._handled = this._watched = null;
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
        w.connectObject('notify::title', () => this._apply(w),
            'unmanaged', () => { this._watched?.delete(w); this._handled?.delete(w); }, this);
        this._apply(w);
    }

    _apply(w) {
        if (!this._handled || this._handled.has(w) || !PIP_TITLE.test(w.get_title() ?? ''))
            return;
        this._handled.add(w);
        // It just appears, without GNOME's zoom-in (only if it isn't on screen yet: this skips
        // the window's next animation, whatever it is).
        const actor = w.get_compositor_private();
        if (actor && !actor.mapped)
            Main.wm.skipNextEffect(actor);
        w.make_above();
        w.stick();
        console.log(`pip-everywhere: "${w.get_title()}" kept on top, on all desktops`);
    }
}
