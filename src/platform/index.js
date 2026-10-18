import { createModernAdapter } from './modern.js';
import { createLegacyAdapter } from './legacy.js';

export const PLAYER_SELECTOR = '[source-view] [uooc-video] video, #player_html5_api';

export function resolvePlatform({ document, location, page, canIgnoreTest, log }) {
    if (/^\/home\/learn\/new\//.test(location.pathname)) {
        if (!page.angular?.element) return null;
        return createModernAdapter({ document, page, location });
    }
    if (/^\/home\/learn\/index\/?$/.test(location.pathname) && document.querySelector('.basic.active')) {
        return createLegacyAdapter({ document, canIgnoreTest, log });
    }
    return null;
}
