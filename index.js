/**
 * Font Slots — SillyTavern extension
 *
 * 설계 요약
 * ─────────────────────────────────────────────────────────────
 * 1. 폰트 파일은 settings.json 에 넣지 않는다.
 *    - 1순위: ST 서버(/api/files/upload)에 실제 파일로 업로드 → /user/files/xxx 로 서빙
 *    - 실패 시: IndexedDB 에 Blob 으로 저장 (브라우저 로컬)
 *    settings 에는 {id, name, family, url} 같은 메타데이터만 들어간다.
 *
 * 2. 웹폰트는 CSS 본문을 저장하지 않고 CSS 주소만 저장한 뒤
 *    런타임에 <link> 로 주입한다. 브라우저 캐시를 그대로 탄다.
 *
 * 3. "슬롯" = 적용 범위 + 폰트 + 크기/행간/자간/굵기.
 *    슬롯 순서대로 #chat 을 반복해 specificity 를 올리므로
 *    아래 슬롯이 위 슬롯을 항상 덮어쓴다.
 */

import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const EXT_ID = 'font-slots';
const FACE_STYLE_ID = 'fs-font-faces';
const RULE_STYLE_ID = 'fs-slot-rules';
const LINK_CLASS = 'fs-font-link';

const DB_NAME = 'font-slots';
const DB_STORE = 'files';

/** 아이콘·SVG 는 폰트 교체 대상에서 제외한다. */
const EXCLUDE = ':not(.fa):not(.fas):not(.far):not(.fab):not([class*="fa-"]):not(svg):not(path)';

/**
 * 코드블럭 이름의 다른 표기들. highlight.js 가 별칭을 정식 이름으로
 * 바꿔서 클래스를 하나 더 붙이기 때문에 같이 걸어둔다.
 */
const LANG_ALIAS = {
    md: 'markdown', js: 'javascript', ts: 'typescript', py: 'python',
    sh: 'bash', yml: 'yaml', rb: 'ruby', ps: 'powershell',
};

/**
 * ```이름 코드블럭을 찾는 셀렉터.
 *
 * ST 는 메시지를 DOMPurify 로 소독하면서 class 하나하나에 'custom-' 을
 * 붙인다. showdown 이 만든 language-md 는 custom-language-md 가 된다.
 * 그 뒤에 highlight.js 가 별칭을 푼 language-markdown 을 접두사 없이
 * 덧붙인다. 그래서 실제 DOM 은 이렇게 생겼다:
 *
 *   class="custom-md custom-language-md hljs language-markdown"
 *
 * 이름을 모르는 블럭(stateboard 등)은 hljs 가 손을 떼므로
 * custom- 붙은 것만 남는다. 나올 수 있는 형태를 전부 건다.
 */
function codeLangSelector(name) {
    const n = String(name || '').trim().toLowerCase().replace(/[^\w.+#-]/g, '');
    if (!n) return 'pre code';

    const names = [n];
    if (LANG_ALIAS[n] && !names.includes(LANG_ALIAS[n])) names.push(LANG_ALIAS[n]);

    const out = [];
    for (const nm of names) {
        out.push(
            `pre code.custom-language-${nm}`,
            `pre code.language-${nm}`,
            `pre code.custom-${nm}`,
        );
    }
    return out.join(', ');
}

/** 셀렉터에서 코드블럭 이름만 되뽑아낸다 (UI 입력칸 채우기용). */
function codeLangOf(selector) {
    const m = /pre\s+code\.(?:custom-)?language-([\w.+#-]+)/.exec(String(selector || ''));
    return m ? m[1] : '';
}

/**
 * 프리셋은 '어디에' + '어디는 빼고' 한 쌍이다.
 * 본문과 상태창이 서로 안 겹치게 기본값을 잡아뒀다.
 */
const PRESETS = [
    { key: 'body', label: '본문 — 코드블럭 빼고 전부', selector: '', exclude: 'pre, code' },
    { key: 'status', label: '상태창 — 코드블럭만', selector: 'pre, pre code', exclude: '' },
    { key: 'statusmd', label: '상태창 — ```md 블록만', selector: codeLangSelector('md'), exclude: '' },
    { key: 'all', label: '메시지 전체 (코드블럭까지)', selector: '', exclude: '' },
    { key: 'quote', label: '인용문', selector: 'blockquote', exclude: '' },
    { key: 'q', label: '따옴표 대사', selector: 'q', exclude: '' },
    { key: 'thought', label: "속마음 — '작은따옴표' 안", selector: '.fs-thought', exclude: '' },
    { key: 'em', label: '기울임', selector: 'em, i', exclude: '' },
    { key: 'strong', label: '굵게', selector: 'strong, b', exclude: '' },
    { key: 'custom', label: '직접 입력…', selector: null, exclude: null },
];

function matchPreset(slot) {
    const found = PRESETS.find(p =>
        p.selector !== null &&
        p.selector === (slot.selector || '') &&
        p.exclude === (slot.exclude || ''));
    return found ? found.key : 'custom';
}

const SAMPLE = '다람쥐 헌 쳇바퀴에 타고파 ABC 123';

// ─────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────

function newSlot(partial = {}) {
    return {
        id: 's' + Math.random().toString(36).slice(2, 9),
        label: '새 슬롯',
        selector: '',        // 적용할 곳. 비우면 메시지 전체
        exclude: '',         // 그중 빼놓을 곳. 여기 걸린 건 자손까지 전부 제외
        fontId: null,
        size: null,
        lineHeight: null,    // 줄간격
        paraGap: null,       // 문단 사이 간격 (px)
        letterSpacing: null,
        weight: 'auto',      // auto | normal | bold
        style: 'auto',       // auto | normal | italic
        color: null,         // 글자 색. null 이면 안 건드림
        enabled: true,
        ...partial,
    };
}

function defaultSettings() {
    return {
        enabled: true,
        wrapThoughts: false,   // '작은따옴표' 를 .fs-thought 로 감쌀지
        colorExclude: '',      // 색만 건드리지 않을 곳 (전역). 다른 확장이 칠하는 영역용
        fonts: [],
        slots: [
            newSlot({ id: 'body', label: '본문', selector: '', exclude: 'pre, code' }),
            newSlot({ id: 'status', label: '상태창', selector: 'pre, pre code', exclude: '' }),
        ],
    };
}

function S() { return extension_settings[EXT_ID]; }

function initSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = defaultSettings();
    }
    const d = defaultSettings();
    for (const [k, v] of Object.entries(d)) {
        if (extension_settings[EXT_ID][k] === undefined) {
            extension_settings[EXT_ID][k] = v;
        }
    }
    if (!Array.isArray(S().slots) || S().slots.length === 0) S().slots = d.slots;
    if (!Array.isArray(S().fonts)) S().fonts = [];

    // 예전 버전에서 저장된 슬롯에 새 항목을 채워준다.
    const template = newSlot();
    S().slots = S().slots.map(slot => {
        for (const [k, v] of Object.entries(template)) {
            if (slot[k] === undefined && k !== 'id') slot[k] = v;
        }
        return slot;
    });
}

function save() { saveSettingsDebounced(); }

// ─────────────────────────────────────────────────────────────
// IndexedDB (서버 업로드 실패 시 폴백)
// ─────────────────────────────────────────────────────────────

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(DB_STORE)) {
                req.result.createObjectStore(DB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbPut(key, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(blob, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbDelete(key) {
    const db = await openDb();
    return new Promise((resolve) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
    });
}

/** IndexedDB 폰트의 blob URL 캐시 (id → objectURL) */
const blobUrls = new Map();

async function resolveBlobUrls() {
    for (const font of S().fonts) {
        if (font.store !== 'idb' || blobUrls.has(font.id)) continue;
        try {
            const blob = await dbGet(font.key);
            if (blob) blobUrls.set(font.id, URL.createObjectURL(blob));
        } catch (err) {
            console.warn('[Font Slots] blob 복원 실패', font.name, err);
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 폰트 등록
// ─────────────────────────────────────────────────────────────

const FORMATS = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };

function extOf(filename) {
    return (filename.split('.').pop() || '').toLowerCase();
}

/** ST 업로드 API는 [a-zA-Z0-9_.-] 만 허용한다. 한글 파일명을 안전하게 바꾼다. */
function safeFileName(original) {
    const ext = extOf(original);
    const stem = original.slice(0, original.length - ext.length - 1);
    const ascii = stem.replace(/[^a-zA-Z0-9_-]/g, '');
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return `fs_${ascii.slice(0, 24) || 'font'}_${stamp}.${ext}`;
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

/** ST 서버에 폰트를 실제 파일로 저장한다. 성공하면 서빙 경로를 돌려준다. */
async function uploadToServer(file) {
    const name = safeFileName(file.name);
    const data = await fileToBase64(file);

    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, data }),
    });

    if (!res.ok) throw new Error(`업로드 거부 (HTTP ${res.status})`);

    const json = await res.json();
    if (!json?.path) throw new Error('서버가 경로를 돌려주지 않음');

    return '/' + String(json.path).replace(/^\/+/, '');
}

async function addFileFont(file, displayName) {
    const ext = extOf(file.name);
    if (!FORMATS[ext]) throw new Error('ttf, otf, woff, woff2 만 쓸 수 있어.');

    const name = (displayName || '').trim() || file.name.replace(/\.[^.]+$/, '');
    if (S().fonts.some(f => f.name === name)) throw new Error(`"${name}" 이름이 이미 있어.`);

    const id = 'f' + Math.random().toString(36).slice(2, 9);
    const family = `fs-${id}`;   // 이름 충돌을 피하려고 내부 family 는 항상 고유하게

    const base = { id, name, family, kind: 'file', format: FORMATS[ext] };

    try {
        const url = await uploadToServer(file);
        S().fonts.push({ ...base, store: 'server', url });
        save();
        return { font: S().fonts.at(-1), store: 'server' };
    } catch (err) {
        console.warn('[Font Slots] 서버 업로드 실패, IndexedDB로 저장함:', err);
        const key = `${id}.${ext}`;
        await dbPut(key, file);
        blobUrls.set(id, URL.createObjectURL(file));
        S().fonts.push({ ...base, store: 'idb', key });
        save();
        return { font: S().fonts.at(-1), store: 'idb', reason: err.message };
    }
}

// ─────────────────────────────────────────────────────────────
// 웹폰트 파싱
// ─────────────────────────────────────────────────────────────

/** 붙여넣은 내용에서 CSS 주소를 뽑아낸다. @import / <link> / 생 URL 전부 처리. */
function extractCssUrl(input) {
    const text = input.trim();

    const importMatch = text.match(/@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    if (importMatch) return importMatch[1].trim();

    const linkMatch = text.match(/<link[^>]+href\s*=\s*['"]([^'"]+)['"]/i);
    if (linkMatch) return linkMatch[1].trim();

    if (/^https?:\/\/\S+$/i.test(text)) return text;

    return null;
}

/** CSS 텍스트에서 font-family 이름들을 중복 없이 모은다. */
function collectFamilies(css) {
    const matches = [...css.matchAll(/font-family\s*:\s*['"]?([^'";}\n]+)['"]?/gi)];
    const names = matches
        .map(m => m[1].trim().replace(/^['"]|['"]$/g, ''))
        .filter(n => n && !/^(inherit|initial|unset|sans-serif|serif|monospace)$/i.test(n));
    return [...new Set(names)];
}

/** 상대 경로 url() 을 절대 경로로 바꾼다. */
function absolutizeUrls(css, baseUrl) {
    const base = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
    return css.replace(
        /url\(\s*['"]?(?!https?:\/\/|data:|\/\/)([^'")]+)['"]?\s*\)/gi,
        (_, p) => `url('${base}${p}')`,
    );
}

/**
 * 웹폰트 입력을 해석한다.
 *  - CSS 주소면 fetch 해서 family 목록을 얻고, 주소만 저장 (kind:'link')
 *  - @font-face 코드면 그대로 저장 (kind:'inline')
 */
async function parseWebFont(input) {
    const cssUrl = extractCssUrl(input);

    if (cssUrl) {
        let families = [];
        try {
            const res = await fetch(cssUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            families = collectFamilies(await res.text());
        } catch (err) {
            // CORS 등으로 못 읽어도 <link> 주입 자체는 되니까 이름만 물어보면 된다.
            throw new Error(
                `CSS를 읽지 못했어 (${err.message}).\n` +
                '폰트 이름 칸에 font-family 이름을 직접 넣고 다시 눌러줘.',
            );
        }
        if (!families.length) throw new Error('CSS 안에서 font-family를 찾지 못했어.');
        return { kind: 'link', cssUrl, families };
    }

    if (/@font-face/i.test(input)) {
        const families = collectFamilies(input);
        if (!families.length) throw new Error('@font-face 안에서 font-family를 찾지 못했어.');
        return { kind: 'inline', css: input.trim(), families };
    }

    throw new Error('@import, <link>, @font-face, 또는 CSS 주소를 붙여넣어줘.');
}

// ─────────────────────────────────────────────────────────────
// 스타일 주입
// ─────────────────────────────────────────────────────────────

function fontSrcUrl(font) {
    if (font.store === 'server') return font.url;
    if (font.store === 'idb') return blobUrls.get(font.id) || null;
    return null;
}

/** 등록된 모든 폰트의 @font-face / <link> 를 문서에 반영한다. */
function injectFaces() {
    document.querySelectorAll('.' + LINK_CLASS).forEach(el => el.remove());

    const rules = [];

    for (const font of S().fonts) {
        if (font.kind === 'file') {
            const src = fontSrcUrl(font);
            if (!src) continue;
            rules.push(
                `@font-face{font-family:'${font.family}';` +
                `src:url('${src}') format('${font.format}');font-display:swap;}`,
            );
        } else if (font.kind === 'inline') {
            rules.push(font.css);
        } else if (font.kind === 'link') {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = font.cssUrl;
            link.className = LINK_CLASS;
            document.head.appendChild(link);
        }
    }

    let style = document.getElementById(FACE_STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = FACE_STYLE_ID;
        document.head.appendChild(style);
    }
    style.textContent = rules.join('\n');
}

/**
 * 슬롯 하나가 만들 셀렉터들.
 * depth 가 클수록 #chat 을 여러 번 써서 specificity 를 올린다 →
 * 목록에서 아래에 있는 슬롯이 위 슬롯을 항상 이긴다.
 */
function splitSelector(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function buildSelectors(depth, selector, exclude) {
    const scope = '#chat'.repeat(depth) + ' .mes_text';
    const parts = splitSelector(selector);
    const excluded = splitSelector(exclude);

    // 제외 대상은 자기 자신과 그 안의 모든 자손을 다 빼야 한다.
    // 코드블럭은 안쪽이 하이라이트용 <span> 으로 잘게 쪼개져 있어서
    // :not(pre) 만으로는 안쪽 span 이 그대로 칠해진다.
    const notChain = excluded.map(e => `:not(${e}):not(${e} *)`).join('');

    const self = parts.length ? parts.map(p => `${scope} ${p}`) : [scope];
    const deep = parts.length
        ? parts.map(p => `${scope} ${p} *${EXCLUDE}${notChain}`)
        : [`${scope} *${EXCLUDE}${notChain}`];

    // 제외 대상은 상속으로도 물들 수 있으니 명시적으로 되돌려준다.
    const reset = excluded.flatMap(e => [`${scope} ${e}`, `${scope} ${e} *`]);

    return { self, deep, reset };
}

function applyRules() {
    let style = document.getElementById(RULE_STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = RULE_STYLE_ID;
        document.head.appendChild(style);
    }

    if (!S().enabled) { style.textContent = ''; return; }

    const lines = [];

    S().slots.forEach((slot, index) => {
        if (!slot.enabled) return;

        const font = S().fonts.find(f => f.id === slot.fontId);
        const decls = [];
        const undo = [];

        if (font) {
            decls.push(`font-family:'${font.family}',sans-serif !important`);
            undo.push('font-family:revert !important');
        }
        if (slot.size) {
            decls.push(`font-size:${slot.size}px !important`);
            undo.push('font-size:var(--mainFontSize, 1rem) !important');
        }
        if (slot.lineHeight) {
            decls.push(`line-height:${slot.lineHeight} !important`);
            undo.push('line-height:normal !important');
        }
        if (slot.letterSpacing) {
            decls.push(`letter-spacing:${slot.letterSpacing}em !important`);
            undo.push('letter-spacing:normal !important');
        }

        const hasParaGap = slot.paraGap !== null && slot.paraGap !== undefined;
        const style = slot.style || 'auto';
        if (!decls.length && slot.weight === 'auto' && style === 'auto' && !hasParaGap) return;

        const { self, deep, reset } = buildSelectors(index + 1, slot.selector, slot.exclude);
        const all = [...self, ...deep];

        lines.push(`/* ${slot.label} */`);
        if (decls.length) lines.push(`${all.join(',')}{${decls.join(';')}}`);

        if (hasParaGap) {
            const paragraphs = self.map(s => `${s} p`).join(',');
            lines.push(`${paragraphs}{margin-block:${slot.paraGap}px !important}`);
        }

        // 제외 범위 되돌리기. 같은 depth 라 뒤에 오는 이 규칙이 위 규칙을 이기고,
        // 아래 슬롯(더 높은 depth)은 여전히 이걸 덮어쓸 수 있다.
        if (reset.length && undo.length) {
            lines.push(`${reset.join(',')}{${undo.join(';')}}`);
        }

        // 색은 따로 낸다. 다른 확장이 자기 영역을 칠하는 경우가 있어서
        // (번역 병기, 상태창 HTML 등) 전역 제외 목록을 여기에만 물린다.
        if (slot.color) {
            const skip = splitSelector(S().colorExclude)
                .map(e => `:not(${e}):not(${e} *)`).join('');
            lines.push(`${all.map(sel => sel + skip).join(',')}{color:${slot.color} !important}`);
            if (reset.length) {
                lines.push(`${reset.join(',')}{color:revert !important}`);
            }
        }

        // 굵기: 'auto' 면 손대지 않는다 → 마크다운 **볼드** 가 살아있음
        if (slot.weight === 'bold') {
            lines.push(`${all.join(',')}{font-weight:700 !important}`);
        } else if (slot.weight === 'normal') {
            const keepBold = all.map(s => `${s}:not(strong):not(b)`).join(',');
            lines.push(`${keepBold}{font-weight:400 !important}`);
        }
        if (slot.weight !== 'auto' && reset.length) {
            lines.push(`${reset.join(',')}{font-weight:revert !important}`);
        }

        // 기울기: 'auto' 면 손대지 않는다 → 마크다운 *이탤릭* 이 살아있음
        if (style === 'italic') {
            lines.push(`${all.join(',')}{font-style:italic !important}`);
        } else if (style === 'normal') {
            const keepItalic = all.map(s => `${s}:not(em):not(i)`).join(',');
            lines.push(`${keepItalic}{font-style:normal !important}`);
        }
        if (style !== 'auto' && reset.length) {
            lines.push(`${reset.join(',')}{font-style:revert !important}`);
        }
    });

    style.textContent = lines.join('\n');
}

function refresh() {
    injectFaces();
    applyRules();
}

// ─────────────────────────────────────────────────────────────
// '작은따옴표' 감싸기
//
// CSS 는 "따옴표로 둘러싸인 글자" 를 고를 수 없다. 선택자는 태그·클래스만
// 본다. 그래서 렌더가 끝난 뒤 텍스트 노드를 훑어서 직접 <span> 을 씌운다.
// 원본 메시지는 건드리지 않으니 저장 내용은 그대로다.
// ─────────────────────────────────────────────────────────────

/*
 * 앞뒤가 '라틴 문자·숫자' 일 때만 막는다.
 * don't, it's, boys' 처럼 영어 아포스트로피는 여전히 안 걸리고,
 * '물건'은 / '속마음'이라고 처럼 조사가 붙는 한국어는 정상으로 걸린다.
 */
const THOUGHT_RE = /(?<![A-Za-z0-9])['‘]([^'’\n]{1,300})['’](?![A-Za-z0-9])/gu;

/** 코드·수식·이미 처리된 곳은 건너뛴다. */
const THOUGHT_SKIP = 'pre, code, .fs-thought, .katex, .mes_img';

function wrapThoughtsIn(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !/['‘]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
            if (node.parentElement?.closest(THOUGHT_SKIP)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);

    for (const node of targets) {
        const text = node.nodeValue;
        THOUGHT_RE.lastIndex = 0;
        if (!THOUGHT_RE.test(text)) continue;

        THOUGHT_RE.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        while ((m = THOUGHT_RE.exec(text)) !== null) {
            if (m.index > last) frag.append(text.slice(last, m.index));
            const span = document.createElement('span');
            span.className = 'fs-thought';
            span.textContent = m[0];   // 따옴표까지 포함해서 감싼다
            frag.append(span);
            last = m.index + m[0].length;
        }
        if (last < text.length) frag.append(text.slice(last));
        node.parentNode.replaceChild(frag, node);
    }
}

function runThoughts(messageId) {
    if (!S().enabled || !S().wrapThoughts) return;
    if (messageId === undefined || messageId === null) {
        document.querySelectorAll('#chat .mes_text').forEach(wrapThoughtsIn);
        return;
    }
    wrapThoughtsIn(document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`));
}

/**
 * ST 는 스트리밍·스와이프·수정·재렌더마다 .mes_text 안을 통째로 갈아끼운다.
 * 이벤트를 일일이 쫓으면 빠지는 경로가 생기므로 #chat 을 통째로 감시한다.
 * 우리가 만든 변경으로 다시 불리는 걸 막으려고 감시를 잠깐 끊고 작업한다.
 */
const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };
let thoughtObserver = null;
let thoughtQueue = new Set();
let thoughtFrame = 0;

function flushThoughts() {
    thoughtFrame = 0;
    const targets = [...thoughtQueue];
    thoughtQueue.clear();
    if (!S().enabled || !S().wrapThoughts) return;

    thoughtObserver?.disconnect();
    for (const el of targets) {
        if (el.isConnected) wrapThoughtsIn(el);
    }
    const chat = document.getElementById('chat');
    if (chat && thoughtObserver) thoughtObserver.observe(chat, OBSERVE_OPTIONS);
}

function startThoughtObserver() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    if (!thoughtObserver) {
        thoughtObserver = new MutationObserver(records => {
            if (!S().enabled || !S().wrapThoughts) return;

            for (const record of records) {
                const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                const own = node?.closest?.('.mes_text');
                if (own) { thoughtQueue.add(own); continue; }
                node?.querySelectorAll?.('.mes_text').forEach(el => thoughtQueue.add(el));
            }

            if (thoughtQueue.size && !thoughtFrame) {
                thoughtFrame = requestAnimationFrame(flushThoughts);
            }
        });
    }

    thoughtObserver.disconnect();
    thoughtObserver.observe(chat, OBSERVE_OPTIONS);
}

function stopThoughtObserver() {
    thoughtObserver?.disconnect();
    thoughtQueue.clear();
    if (thoughtFrame) { cancelAnimationFrame(thoughtFrame); thoughtFrame = 0; }
}

// ─────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────

function toast(message, kind = 'ok') {
    const el = document.getElementById('fs-toast');
    if (!el) return;
    el.textContent = message;
    el.className = `fs-toast fs-toast-${kind}`;
    el.hidden = false;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.hidden = true; }, 3000);
}

function showError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.hidden = false;
}

function esc(value) {
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// 슬롯 UI
// ─────────────────────────────────────────────────────────────

function fontOptions(selectedId) {
    const options = ['<option value="">— 폰트 없음 (크기만 적용) —</option>'];
    for (const font of S().fonts) {
        const sel = font.id === selectedId ? ' selected' : '';
        options.push(`<option value="${font.id}"${sel}>${esc(font.name)}</option>`);
    }
    return options.join('');
}

function presetOptions(slot) {
    const current = matchPreset(slot);
    return PRESETS.map(p =>
        `<option value="${p.key}"${p.key === current ? ' selected' : ''}>${esc(p.label)}</option>`,
    ).join('');
}

/** 이 슬롯이 실제로 어디에 걸리는지 사람 말로 풀어준다. */
function describeScope(slot) {
    const where = slot.selector ? slot.selector : '메시지 전체';
    return slot.exclude ? `${where} (단, ${slot.exclude} 는 빼고)` : where;
}

/** 순서를 눈으로 알 수 있게 슬롯마다 고정 색 띠를 준다. */
const SPINES = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#BA7517', '#D4537E'];

/** 접힌 상태에서 읽는 한 줄 요약. */
function summarize(slot) {
    const font = S().fonts.find(f => f.id === slot.fontId);
    const bits = [font ? font.name : '폰트 없음'];
    if (slot.size) bits.push(`${slot.size}px`);
    if (slot.lineHeight) bits.push(`줄 ${slot.lineHeight}`);
    if (slot.paraGap !== null && slot.paraGap !== undefined) bits.push(`문단 ${slot.paraGap}px`);
    if (slot.letterSpacing) bits.push(`자간 ${slot.letterSpacing}`);
    if (slot.color) bits.push(slot.color);
    if (slot.weight === 'bold') bits.push('굵게');
    if (slot.weight === 'normal') bits.push('얇게');
    return bits.join(' · ');
}

/** 펼쳐둔 슬롯. 화면 상태라 settings 에는 넣지 않는다. */
const openSlots = new Set();

function renderSlots() {
    const list = document.getElementById('fs-slot-list');
    if (!list) return;

    list.innerHTML = '';

    S().slots.forEach((slot, index) => {
        const isCustom = matchPreset(slot) === 'custom';
        const isOpen = openSlots.has(slot.id);

        const card = document.createElement('div');
        card.className = 'fs-slot' + (slot.enabled ? '' : ' fs-slot-off');
        card.dataset.id = slot.id;
        card.style.setProperty('--fs-spine', SPINES[index % SPINES.length]);

        card.innerHTML = `
            <div class="fs-row">
                <span class="fs-order">${index + 1}</span>
                <button class="fs-summary" aria-expanded="${isOpen}">
                    <span class="fs-summary-title">${esc(slot.label)}</span>
                    <span class="fs-summary-line">${esc(summarize(slot))}</span>
                    <span class="fs-summary-scope">${esc(describeScope(slot))}</span>
                </button>
                <button class="fs-icon fs-slot-on" aria-label="이 슬롯 켜고 끄기">
                    <i class="fa-solid ${slot.enabled ? 'fa-eye' : 'fa-eye-slash'}"></i>
                </button>
                <button class="fs-icon fs-chevron" aria-label="슬롯 펼치기">
                    <i class="fa-solid ${isOpen ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
                </button>
            </div>

            <div class="fs-body" ${isOpen ? '' : 'hidden'}>
                <label class="fs-field">
                    <span>슬롯 이름</span>
                    <input type="text" class="text_pole fs-slot-label" value="${esc(slot.label)}">
                </label>

                <label class="fs-field">
                    <span>적용 범위</span>
                    <select class="text_pole fs-slot-preset">${presetOptions(slot)}</select>
                </label>

                <div class="fs-custom" ${isCustom ? '' : 'hidden'}>
                    <label class="fs-field">
                        <span>코드블럭 이름으로 채우기 (백틱 뒤에 붙는 말)</span>
                        <input type="text" class="text_pole fs-slot-codelang"
                            value="${esc(codeLangOf(slot.selector))}" placeholder="예: md, stateboard, status">
                    </label>
                    <label class="fs-field">
                        <span>적용할 곳 (비우면 메시지 전체)</span>
                        <div class="fs-custom-row">
                            <input type="text" class="text_pole fs-slot-selector"
                                value="${esc(slot.selector)}" placeholder="예: pre code.language-md">
                            <button class="menu_button fs-pick">요소 찍기</button>
                        </div>
                    </label>
                    <label class="fs-field">
                        <span>그중 뺄 곳</span>
                        <input type="text" class="text_pole fs-slot-exclude"
                            value="${esc(slot.exclude)}" placeholder="예: pre, code">
                    </label>
                </div>

                <label class="fs-field">
                    <span>폰트</span>
                    <select class="text_pole fs-slot-font">${fontOptions(slot.fontId)}</select>
                </label>

                <div class="fs-grid">
                    <label class="fs-field">
                        <span>크기 (px)</span>
                        <input type="number" class="text_pole fs-slot-size" min="8" max="48" step="1"
                            value="${slot.size ?? ''}" placeholder="기본">
                    </label>
                    <label class="fs-field">
                        <span>줄간격 (배수)</span>
                        <input type="number" class="text_pole fs-slot-lh" min="0.8" max="3" step="0.05"
                            value="${slot.lineHeight ?? ''}" placeholder="기본">
                    </label>
                    <label class="fs-field">
                        <span>문단 간격 (px)</span>
                        <input type="number" class="text_pole fs-slot-gap" min="0" max="60" step="1"
                            value="${slot.paraGap ?? ''}" placeholder="기본">
                    </label>
                    <label class="fs-field">
                        <span>자간 (em)</span>
                        <input type="number" class="text_pole fs-slot-ls" min="-0.1" max="0.3" step="0.01"
                            value="${slot.letterSpacing ?? ''}" placeholder="기본">
                    </label>
                    <label class="fs-field">
                        <span>굵기</span>
                        <select class="text_pole fs-slot-weight">
                            <option value="auto"${slot.weight === 'auto' ? ' selected' : ''}>그대로</option>
                            <option value="normal"${slot.weight === 'normal' ? ' selected' : ''}>얇게</option>
                            <option value="bold"${slot.weight === 'bold' ? ' selected' : ''}>굵게</option>
                        </select>
                    </label>
                    <label class="fs-field fs-span2">
                        <span>글자 색</span>
                        <div class="fs-color-row">
                            <input type="color" class="fs-slot-color"
                                value="${slot.color || '#ffffff'}">
                            <button class="menu_button fs-slot-color-off"
                                ${slot.color ? '' : 'disabled'}>색 없음</button>
                        </div>
                    </label>
                    <label class="fs-field">
                        <span>기울기</span>
                        <select class="text_pole fs-slot-style">
                            <option value="auto"${(slot.style || 'auto') === 'auto' ? ' selected' : ''}>그대로</option>
                            <option value="normal"${slot.style === 'normal' ? ' selected' : ''}>똑바로</option>
                            <option value="italic"${slot.style === 'italic' ? ' selected' : ''}>기울임</option>
                        </select>
                    </label>
                </div>

                <div class="fs-body-foot">
                    <button class="fs-icon fs-slot-up" aria-label="위로" ${index === 0 ? 'disabled' : ''}>
                        <i class="fa-solid fa-arrow-up"></i>
                    </button>
                    <button class="fs-icon fs-slot-down" aria-label="아래로" ${index === S().slots.length - 1 ? 'disabled' : ''}>
                        <i class="fa-solid fa-arrow-down"></i>
                    </button>
                    <button class="fs-icon fs-slot-del" aria-label="슬롯 삭제">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `;

        bindSlotCard(card, slot);
        list.appendChild(card);
    });
}

function bindSlotCard(card, slot) {
    const titleEl = card.querySelector('.fs-summary-title');
    const lineEl = card.querySelector('.fs-summary-line');
    const scopeEl = card.querySelector('.fs-summary-scope');

    const refreshSummary = () => {
        titleEl.textContent = slot.label;
        lineEl.textContent = summarize(slot);
        scopeEl.textContent = describeScope(slot);
    };

    const commit = () => { refreshSummary(); applyRules(); save(); };

    const body = card.querySelector('.fs-body');
    const chevron = card.querySelector('.fs-chevron');
    const summaryButton = card.querySelector('.fs-summary');

    const toggleOpen = () => {
        const open = body.hidden;
        body.hidden = !open;
        summaryButton.setAttribute('aria-expanded', String(open));
        chevron.querySelector('i').className = `fa-solid fa-chevron-${open ? 'up' : 'down'}`;
        if (open) openSlots.add(slot.id); else openSlots.delete(slot.id);
    };

    summaryButton.addEventListener('click', toggleOpen);
    chevron.addEventListener('click', toggleOpen);

    card.querySelector('.fs-slot-on').addEventListener('click', () => {
        slot.enabled = !slot.enabled;
        card.classList.toggle('fs-slot-off', !slot.enabled);
        card.querySelector('.fs-slot-on i').className =
            `fa-solid ${slot.enabled ? 'fa-eye' : 'fa-eye-slash'}`;
        applyRules();
        save();
    });

    card.querySelector('.fs-slot-label').addEventListener('input', e => {
        slot.label = e.target.value;
        refreshSummary();
        save();
    });

    card.querySelector('.fs-slot-preset').addEventListener('change', e => {
        const preset = PRESETS.find(p => p.key === e.target.value);
        const custom = card.querySelector('.fs-custom');

        if (!preset || preset.key === 'custom') {
            custom.hidden = false;
            card.querySelector('.fs-slot-selector').focus();
            return;
        }

        custom.hidden = true;
        slot.selector = preset.selector;
        slot.exclude = preset.exclude;
        card.querySelector('.fs-slot-selector').value = preset.selector;
        card.querySelector('.fs-slot-exclude').value = preset.exclude;
        card.querySelector('.fs-slot-codelang').value = codeLangOf(preset.selector);
        commit();
    });

    card.querySelector('.fs-slot-selector').addEventListener('input', e => {
        slot.selector = e.target.value.trim();
        commit();
    });

    card.querySelector('.fs-slot-exclude').addEventListener('input', e => {
        slot.exclude = e.target.value.trim();
        commit();
    });

    card.querySelector('.fs-pick').addEventListener('click', () => {
        startPicker(selector => {
            slot.selector = selector;
            card.querySelector('.fs-slot-selector').value = selector;
            commit();
            toast(`적용할 곳: ${selector}`);
        });
    });

    card.querySelector('.fs-slot-font').addEventListener('change', e => {
        slot.fontId = e.target.value || null;
        commit();
    });

    const num = (el, key, parse) => el.addEventListener('input', e => {
        const raw = e.target.value.trim();
        slot[key] = raw === '' ? null : parse(raw);
        commit();
    });

    num(card.querySelector('.fs-slot-size'), 'size', v => parseInt(v, 10));
    num(card.querySelector('.fs-slot-lh'), 'lineHeight', v => parseFloat(v));
    num(card.querySelector('.fs-slot-gap'), 'paraGap', v => parseInt(v, 10));
    num(card.querySelector('.fs-slot-ls'), 'letterSpacing', v => parseFloat(v));

    card.querySelector('.fs-slot-weight').addEventListener('change', e => {
        slot.weight = e.target.value;
        commit();
    });

    card.querySelector('.fs-slot-style').addEventListener('change', e => {
        slot.style = e.target.value;
        commit();
    });

    const colorInput = card.querySelector('.fs-slot-color');
    const colorOff = card.querySelector('.fs-slot-color-off');

    colorInput.addEventListener('input', e => {
        slot.color = e.target.value;
        colorOff.disabled = false;
        commit();
    });

    colorOff.addEventListener('click', () => {
        slot.color = null;
        colorOff.disabled = true;
        commit();
    });

    card.querySelector('.fs-slot-codelang').addEventListener('input', e => {
        const name = e.target.value.trim();
        if (!name) return;
        slot.selector = codeLangSelector(name);
        card.querySelector('.fs-slot-selector').value = slot.selector;
        commit();
    });

    card.querySelector('.fs-slot-up').addEventListener('click', () => moveSlot(slot.id, -1));
    card.querySelector('.fs-slot-down').addEventListener('click', () => moveSlot(slot.id, 1));

    card.querySelector('.fs-slot-del').addEventListener('click', () => {
        if (S().slots.length <= 1) { toast('슬롯은 하나 이상 있어야 해.', 'warn'); return; }
        S().slots = S().slots.filter(s => s.id !== slot.id);
        openSlots.delete(slot.id);
        renderSlots();
        applyRules();
        save();
        toast(`"${slot.label}" 슬롯 삭제됨`);
    });
}

function moveSlot(id, direction) {
    const slots = S().slots;
    const from = slots.findIndex(s => s.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= slots.length) return;
    [slots[from], slots[to]] = [slots[to], slots[from]];
    renderSlots();
    applyRules();
    save();
}

// ─────────────────────────────────────────────────────────────
// 요소 찍기
// ─────────────────────────────────────────────────────────────

function selectorFor(element) {
    const tag = element.tagName.toLowerCase();
    const classes = [...element.classList]
        .filter(c => !/^(hljs|mes_text)$/.test(c) && !c.startsWith('fs-'));

    if (classes.length) return `${tag}.${classes[0]}`;

    const parent = element.parentElement;
    if (parent && parent.tagName.toLowerCase() === 'pre') return 'pre > ' + tag;
    return tag;
}

function startPicker(onPick) {
    const chat = document.getElementById('chat');
    if (!chat) { toast('채팅창을 찾지 못했어.', 'warn'); return; }

    document.body.classList.add('fs-picking');
    toast('채팅에서 원하는 부분을 탭해줘. (Esc 로 취소)', 'info');

    const cleanup = () => {
        document.body.classList.remove('fs-picking');
        chat.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
    };

    const onClick = event => {
        const inside = event.target.closest('.mes_text');
        if (!inside) return;
        event.preventDefault();
        event.stopPropagation();
        cleanup();
        onPick(selectorFor(event.target));
    };

    const onKey = event => {
        if (event.key !== 'Escape') return;
        cleanup();
        toast('취소됨', 'info');
    };

    chat.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
}

// ─────────────────────────────────────────────────────────────
// 폰트 목록 UI
// ─────────────────────────────────────────────────────────────

const STORE_LABEL = {
    server: '서버 파일',
    idb: '브라우저 저장',
};

function renderFonts() {
    const list = document.getElementById('fs-font-list');
    const note = document.getElementById('fs-storage-note');
    if (!list) return;

    if (!S().fonts.length) {
        list.innerHTML = '<div class="fs-empty">아직 등록한 폰트가 없어.<br>‘폰트 추가’ 탭에서 파일이나 웹폰트를 넣어줘.</div>';
        if (note) note.textContent = '';
        return;
    }

    list.innerHTML = '';

    for (const font of S().fonts) {
        const usedBy = S().slots.filter(s => s.fontId === font.id).map(s => s.label);
        const badge = font.kind === 'file'
            ? STORE_LABEL[font.store] || font.store
            : (font.kind === 'link' ? '웹폰트' : 'CSS 직접');

        const row = document.createElement('div');
        row.className = 'fs-font';
        row.innerHTML = `
            <div class="fs-font-top">
                <span class="fs-font-name">${esc(font.name)}</span>
                <span class="fs-font-badge">${esc(badge)}</span>
            </div>
            <div class="fs-font-sample" style="font-family:'${font.family}',sans-serif">${SAMPLE}</div>
            <div class="fs-font-bottom">
                <span class="fs-font-used">${usedBy.length ? '사용 중: ' + esc(usedBy.join(', ')) : '어느 슬롯에도 안 쓰는 중'}</span>
                <button class="fs-icon fs-font-del" data-id="${font.id}" title="삭제">✕</button>
            </div>
        `;
        list.appendChild(row);
    }

    list.querySelectorAll('.fs-font-del').forEach(button => {
        button.addEventListener('click', () => removeFont(button.dataset.id));
    });

    const serverCount = S().fonts.filter(f => f.store === 'server').length;
    const idbCount = S().fonts.filter(f => f.store === 'idb').length;
    if (note) {
        const parts = [];
        if (serverCount) parts.push(`${serverCount}개는 ST 서버의 data/<user>/files/ 에 저장돼 있어 (다른 기기에서도 보임)`);
        if (idbCount) parts.push(`${idbCount}개는 이 브라우저에만 저장돼 있어 (다른 기기에선 안 보임)`);
        note.textContent = parts.join(' · ');
    }
}

async function removeFont(id) {
    const font = S().fonts.find(f => f.id === id);
    if (!font) return;

    for (const slot of S().slots) {
        if (slot.fontId === id) slot.fontId = null;
    }

    if (font.store === 'idb') {
        await dbDelete(font.key);
        const url = blobUrls.get(id);
        if (url) URL.revokeObjectURL(url);
        blobUrls.delete(id);
    }

    if (font.store === 'server' && font.url) {
        // 서버 파일도 같이 지운다. 실패해도 목록에서는 사라진다.
        try {
            await fetch('/api/files/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ path: font.url.replace(/^\//, '') }),
            });
        } catch (err) {
            console.warn('[Font Slots] 서버 파일 삭제 실패', err);
        }
    }

    S().fonts = S().fonts.filter(f => f.id !== id);
    save();
    refresh();
    renderFonts();
    renderSlots();
    toast(`"${font.name}" 삭제됨`);
}

// ─────────────────────────────────────────────────────────────
// 폰트 추가 탭
// ─────────────────────────────────────────────────────────────

let pendingFile = null;

function previewFace(css, previewId, family) {
    let style = document.getElementById('fs-preview-face');
    if (!style) {
        style = document.createElement('style');
        style.id = 'fs-preview-face';
        document.head.appendChild(style);
    }
    style.textContent = css;
    const target = document.getElementById(previewId);
    if (target) target.style.fontFamily = `'${family}', sans-serif`;
}

function bindFileTab() {
    const drop = document.getElementById('fs-drop');
    const input = document.getElementById('fs-file');
    const dropText = document.getElementById('fs-drop-text');

    const accept = async file => {
        const ext = extOf(file.name);
        if (!FORMATS[ext]) { showError('fs-file-error', 'ttf, otf, woff, woff2 만 쓸 수 있어.'); return; }

        pendingFile = file;
        showError('fs-file-error', '');
        dropText.textContent = file.name;

        const url = URL.createObjectURL(file);
        previewFace(
            `@font-face{font-family:'fs-pending';src:url('${url}') format('${FORMATS[ext]}');}`,
            'fs-file-preview-text', 'fs-pending',
        );
        document.getElementById('fs-file-preview').hidden = false;
    };

    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('fs-drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('fs-drag'));
    drop.addEventListener('drop', e => {
        e.preventDefault();
        drop.classList.remove('fs-drag');
        if (e.dataTransfer.files[0]) accept(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => { if (input.files[0]) accept(input.files[0]); });

    document.getElementById('fs-file-add').addEventListener('click', async () => {
        if (!pendingFile) { showError('fs-file-error', '먼저 파일을 골라줘.'); return; }

        const button = document.getElementById('fs-file-add');
        button.disabled = true;
        button.textContent = '저장 중…';

        try {
            const nameInput = document.getElementById('fs-file-name');
            const { font, store, reason } = await addFileFont(pendingFile, nameInput.value);

            pendingFile = null;
            input.value = '';
            nameInput.value = '';
            dropText.textContent = '';
            document.getElementById('fs-file-preview').hidden = true;
            showError('fs-file-error', '');

            refresh();
            renderFonts();
            renderSlots();

            if (store === 'server') {
                toast(`"${font.name}" 저장됨 — 서버 파일`);
            } else {
                toast(`"${font.name}" 저장됨 — 이 브라우저에만 (${reason})`, 'warn');
            }
        } catch (err) {
            showError('fs-file-error', err.message);
        } finally {
            button.disabled = false;
            button.textContent = '폰트 저장';
        }
    });
}

function bindWebTab() {
    const textarea = document.getElementById('fs-web-css');
    const nameInput = document.getElementById('fs-web-name');

    document.getElementById('fs-web-add').addEventListener('click', async () => {
        const input = textarea.value.trim();
        const typedName = nameInput.value.trim();

        if (!input) { showError('fs-web-error', 'CSS 코드나 주소를 붙여넣어줘.'); return; }

        const button = document.getElementById('fs-web-add');
        button.disabled = true;
        button.textContent = '확인 중…';

        try {
            let parsed;
            try {
                parsed = await parseWebFont(input);
            } catch (err) {
                // CSS를 못 읽었는데 이름을 직접 줬으면 그걸로 진행한다.
                const cssUrl = extractCssUrl(input);
                if (cssUrl && typedName) {
                    parsed = { kind: 'link', cssUrl, families: [typedName] };
                } else {
                    throw err;
                }
            }

            let family = parsed.families[0];
            if (parsed.families.length > 1) {
                family = await pickFamily(parsed);
                if (!family) { showError('fs-web-error', ''); return; }
            }

            const name = typedName || family;
            if (S().fonts.some(f => f.name === name)) throw new Error(`"${name}" 이름이 이미 있어.`);

            const id = 'f' + Math.random().toString(36).slice(2, 9);
            const font = parsed.kind === 'link'
                ? { id, name, family, kind: 'link', cssUrl: parsed.cssUrl }
                : { id, name, family, kind: 'inline', css: parsed.css };

            S().fonts.push(font);
            save();

            textarea.value = '';
            nameInput.value = '';
            document.getElementById('fs-web-preview').hidden = true;
            showError('fs-web-error', '');

            refresh();
            renderFonts();
            renderSlots();
            toast(`"${name}" 저장됨 — 웹폰트`);
        } catch (err) {
            showError('fs-web-error', err.message);
        } finally {
            button.disabled = false;
            button.textContent = '폰트 저장';
        }
    });
}

/** CSS 한 장에 여러 패밀리가 있을 때 고르는 창 */
function pickFamily(parsed) {
    return new Promise(resolve => {
        // 미리보기를 위해 실제 페이스를 먼저 로드해 둔다.
        if (parsed.kind === 'link') {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = parsed.cssUrl;
            link.id = 'fs-picker-face';
            document.head.appendChild(link);
        } else {
            previewFace(parsed.css, 'fs-web-preview-text', parsed.families[0]);
        }

        const overlay = document.createElement('div');
        overlay.className = 'fs-modal';
        overlay.innerHTML = `
            <div class="fs-modal-box">
                <div class="fs-modal-title">어느 폰트를 쓸까?</div>
                <div class="fs-modal-sub">이 CSS 안에 ${parsed.families.length}개가 들어 있어.</div>
                <div class="fs-modal-list"></div>
                <button class="menu_button fs-wide fs-modal-cancel">취소</button>
            </div>
        `;

        const finish = value => {
            overlay.remove();
            document.getElementById('fs-picker-face')?.remove();
            resolve(value);
        };

        const list = overlay.querySelector('.fs-modal-list');
        for (const family of parsed.families) {
            const button = document.createElement('button');
            button.className = 'fs-modal-item';
            button.innerHTML = `
                <span class="fs-modal-item-name">${esc(family)}</span>
                <span class="fs-modal-item-sample" style="font-family:'${esc(family)}',sans-serif">${SAMPLE}</span>
            `;
            button.addEventListener('click', () => finish(family));
            list.appendChild(button);
        }

        overlay.querySelector('.fs-modal-cancel').addEventListener('click', () => finish(null));
        overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });

        document.body.appendChild(overlay);
    });
}

// ─────────────────────────────────────────────────────────────
// 공통 바인딩
// ─────────────────────────────────────────────────────────────

function bindShell() {
    document.querySelectorAll('#font-slots-panel .fs-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#font-slots-panel .fs-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('#font-slots-panel .fs-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`fs-tab-${tab.dataset.tab}`)?.classList.add('active');
            if (tab.dataset.tab === 'fonts') renderFonts();
            if (tab.dataset.tab === 'slots') renderSlots();
        });
    });

    const master = document.getElementById('fs-enabled');
    master.checked = S().enabled;
    master.addEventListener('change', () => {
        S().enabled = master.checked;
        applyRules();
        save();
        toast(master.checked ? '폰트 적용 켜짐' : '폰트 적용 꺼짐', 'info');
    });

    const thoughts = document.getElementById('fs-wrap-thoughts');
    if (thoughts) {
        thoughts.checked = !!S().wrapThoughts;
        thoughts.addEventListener('change', () => {
            S().wrapThoughts = thoughts.checked;
            save();
            if (thoughts.checked) { startThoughtObserver(); runThoughts(); }
            else { stopThoughtObserver(); toast('새로고침하면 따옴표 감싸기가 풀려.', 'info'); }
        });
    }

    const colorSkip = document.getElementById('fs-color-exclude');
    if (colorSkip) {
        colorSkip.value = S().colorExclude || '';
        colorSkip.addEventListener('input', () => {
            S().colorExclude = colorSkip.value.trim();
            applyRules();
            save();
        });
    }

    document.getElementById('fs-add-slot').addEventListener('click', () => {
        S().slots.push(newSlot({ label: `슬롯 ${S().slots.length + 1}` }));
        renderSlots();
        save();
    });
}

// ─────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────

jQuery(async () => {
    initSettings();

    const baseUrl = import.meta.url.replace(/index\.js.*$/, '');
    const html = await $.get(`${baseUrl}index.html`);
    $('#extensions_settings2').append(html);

    bindShell();
    bindFileTab();
    bindWebTab();

    startThoughtObserver();

    await resolveBlobUrls();
    refresh();
    renderSlots();
    renderFonts();
    runThoughts();
});
