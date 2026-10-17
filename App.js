import 'react-native-url-polyfill/auto';
import React, { useState, useCallback, useEffect, useRef, useMemo, useContext, useImperativeHandle } from 'react';
import {
  View, Text as RNText, StyleSheet, Pressable, Dimensions,
  FlatList, ActivityIndicator, ScrollView, TextInput, Animated, PanResponder,
  Modal, KeyboardAvoidingView, Platform, Keyboard, AppState, Alert as RNAlert, Share,
  // Inside full-screen pop-ups (note editor, debate, Explain it back) React Native's own SafeAreaView is the one that
  // reliably applies the notch spacing; the safe-area library one (used for the main app below) did not there.
  SafeAreaView as RNSafeAreaView,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as Font from 'expo-font';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
// The safe-area SafeAreaView works on Android too (React Native's own only works on iOS), and reports the real notch / status bar / home-bar insets.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import * as Speech from 'expo-speech';
import { setAudioModeAsync } from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'react-native';
import { useFonts, Cinzel_700Bold, Cinzel_600SemiBold } from '@expo-google-fonts/cinzel';
import { Inter_400Regular, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { BlurView } from 'expo-blur';

// The app's main screens: the safe-area library's version on Android (React Native's own does nothing there), and
// React Native's own on iPhone, which is the version that was already working. (Web has no insets either way.)
const RootSafeArea = Platform.OS === 'android' ? SafeAreaView : RNSafeAreaView;


// =====================================================================================
// Web compatibility. Everything in this block is only ACTIVE when Platform.OS === 'web';
// on iPhone / Android `Text` and `Alert` below are simply React Native's own, so native
// behaviour is exactly what it was.
// =====================================================================================

// Alert.alert is an empty function in react-native-web, so confirmations would silently never
// appear. This gives web the same call shape using the browser's own dialogs.
const WebAlert = {
  alert(title, message, buttons) {
    const text = [title, message].filter(Boolean).join('\n\n');
    const list = Array.isArray(buttons) && buttons.length ? buttons : [{ text: 'OK' }];
    if (list.length === 1) {
      window.alert(text);
      if (list[0].onPress) list[0].onPress();
      return;
    }
    // Two or more buttons: the cancel-style one is "Cancel", the first other one is the action.
    const cancel = list.find((b) => b.style === 'cancel');
    const action = list.find((b) => b !== cancel);
    if (window.confirm(text)) {
      if (action && action.onPress) action.onPress();
    } else if (cancel && cancel.onPress) {
      cancel.onPress();
    }
  },
};
const Alert = Platform.OS === 'web' ? WebAlert : RNAlert;

// react-native-web has no onTextLayout (which the card's explanation pagination, the share
// image's text fitting and the wordmark use). This reads the rendered lines straight from the
// page: each character's box is grouped into lines, and the result has the same shape native
// reports ({ text, x, y, width, height } per line).
function webTextLines(el) {
  if (!el || typeof document === 'undefined' || !el.getBoundingClientRect || !document.createTreeWalker) return null;
  const box = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.25;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const lines = [];
  let node = walker.nextNode();
  while (node) {
    const str = node.nodeValue || '';
    for (let i = 0; i < str.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rects = range.getClientRects();
      const r = rects.length ? rects[rects.length - 1] : null;
      if (r && (r.width > 0 || r.height > 0)) {
        let line = lines[lines.length - 1];
        if (!line || r.top > line.top + fontSize * 0.5) {
          line = { top: r.top, left: r.left, right: r.right, text: '' };
          lines.push(line);
        }
        line.text += str[i];
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
      }
    }
    node = walker.nextNode();
  }
  if (!lines.length) return [];
  return lines.map((l) => ({
    text: l.text,
    x: l.left - box.left,
    y: l.top - box.top,
    width: l.right - l.left,
    height: lineHeight,
  }));
}

const WebText = React.forwardRef(function WebText({ onTextLayout, onLayout, ...rest }, forwardedRef) {
  const nodeRef = useRef(null);
  const cbRef = useRef(onTextLayout);
  cbRef.current = onTextLayout;
  const setRef = useCallback((n) => {
    nodeRef.current = n;
    if (typeof forwardedRef === 'function') forwardedRef(n);
    else if (forwardedRef) forwardedRef.current = n;
  }, [forwardedRef]);
  const measure = useCallback(() => {
    if (!cbRef.current) return;
    const lines = webTextLines(nodeRef.current);
    if (lines) cbRef.current({ nativeEvent: { lines } });
  }, []);
  const handleLayout = useCallback((e) => {
    if (onLayout) onLayout(e);
    measure();
  }, [onLayout, measure]);
  const flat = Array.isArray(rest.children) ? rest.children.join('') : String(rest.children ?? '');
  useEffect(() => {
    if (!onTextLayout) return undefined;
    const t = setTimeout(measure, 0);
    return () => clearTimeout(t);
  }, [flat, onTextLayout, measure]);
  return <RNText {...rest} ref={setRef} onLayout={handleLayout} />;
});
// Large text: the phone's text-size setting is respected, but capped so fixed-height layouts (cards,
// tab bar, buttons) can't be broken by the very largest accessibility sizes. Native only; web is unchanged.
const MAX_FONT_SCALE = 1.3;
const CARD_MAX_FONT_SCALE = 1.2; // card body text is measured and paginated, so it is capped a little tighter
const ScaledText = React.forwardRef(function ScaledText(props, ref) {
  return <RNText maxFontSizeMultiplier={MAX_FONT_SCALE} {...props} ref={ref} />;
});
const Text = Platform.OS === 'web' ? WebText : ScaledText;

// ---- Web card pagers (Feed, Today's 3, card detail) ----
// react-native-web turns pagingEnabled into snapping on the list's direct children (not each card)
// and ignores snapToInterval, so cards would scroll freely. On web each card cell snaps itself
// with CSS scroll-snap instead. Mounting dozens of full cards at once is also slow in a browser,
// so only cards within 2 of the one on screen are real; the rest are empty placeholders of the
// same height (scroll positions stay exact). None of this runs on native.
const WEB_SNAP_ITEM = { scrollSnapAlign: 'start', scrollSnapStop: 'always' };

function webSnapItem(node) {
  return Platform.OS === 'web' ? <View style={WEB_SNAP_ITEM}>{node}</View> : node;
}

// Props that switch a card FlatList to CSS snapping on web (snapOn=false leaves snapping off).
function webPagerListProps(snapOn) {
  if (Platform.OS !== 'web') return {};
  return { pagingEnabled: false, style: { flex: 1, ...(snapOn ? { scrollSnapType: 'y mandatory' } : null) } };
}

// Tracks which card is on screen. onScroll is only meaningful on web.
function useWebPager(listHeight) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(0);
  const setActive = useCallback((idx) => {
    if (idx !== activeRef.current) { activeRef.current = idx; setActiveIndex(idx); }
  }, []);
  const onScroll = useCallback((e) => {
    setActive(Math.round(e.nativeEvent.contentOffset.y / Math.max(1, listHeight)));
  }, [listHeight, setActive]);
  return { activeIndex, setActive, onScroll };
}

let cachedVoiceId;
async function getBestVoiceId() {
  if (cachedVoiceId !== undefined) return cachedVoiceId;
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    const preferred = voices.find(
      (v) => v.language && v.language.startsWith('en') && v.quality === Speech.VoiceQuality.Enhanced
    );
    cachedVoiceId = preferred ? preferred.identifier : undefined;
  } catch (e) {
    cachedVoiceId = undefined;
  }
  return cachedVoiceId;
}

// ---- App identity & share-link config (the single place to change either) ----
// Plain text always uses APP_NAME as typed ("Kepos", ordinary E); only the <Wordmark> logo adds
// the bar over the E. Used by: the Home wordmark and tagline, the "Ask <APP_NAME>" sheet title, the debate-mode
// description, the "already belongs to another <APP_NAME> account" and "Couldn't reach
// <APP_NAME>" auth messages, the share sheet's "Send in <APP_NAME>" button, and the share image
// footer. (Not changed on purpose: the 'agora_device_id' storage key, the edge function slug,
// and component/function names — those are internal identifiers, not user-facing text.)
const APP_NAME = 'Kepos';
const APP_NAME_SUFFIX = '';
const APP_TAGLINE = 'Think deeper. Grow closer.';
// The Kepos marks (gate mark 944 x 704, header icon 900 x 671) share this shape: width = height x this ratio.
const KEPOS_MARK_ASPECT = 944 / 704;
// Home header mark height in points (about the wordmark + tagline block). Width follows the ratio.
const HOME_MARK_HEIGHT = 78;
// While SHARE_LINKS_ENABLED is false, no link is ever added to a share image, caption or message.
const SHARE_BASE_URL = 'https://example.com';
const SHARE_LINKS_ENABLED = false;

// ---- Wordmark: KEPOS in Cinzel capitals with a gold bar (macron) over the E ----
// The bar is a separate View, not an "Ē" glyph, so it doesn't depend on the font and can be gold.
// Everything is relative to `size`, so it scales. To nudge the look, change only these numbers:
const WORDMARK_BAR = {
  widthOfE: 0.7,       // bar width as a fraction of the E's width
  thickness: 0.06,     // bar thickness as a fraction of the font size
  gap: 0.08,           // clear space between the bar and the top of the E, as a fraction of font size
  nudge: 0,            // extra vertical shift as a fraction of font size: negative = up, positive = down
  capTopFallback: 0.3, // where the top of the E is if the device doesn't report font metrics (fraction of size)
};

// size: font size. lineHeight: optional, same as the old Text. offsetY: optional visual shift of the
// wordmark (Home uses 13). suffixStyle: style for APP_NAME_SUFFIX, rendered only if it's non-empty.
// readyRef: optional; the share image uses it to wait until the bar has been measured and drawn.
function WordmarkSingle({ size = 32, fontFamily = 'Cinzel_700Bold', lineHeight, offsetY = 0, suffixStyle, style, readyRef, letterSpacing = 0 }) {
  const name = APP_NAME.toUpperCase();
  const eIdx = name.indexOf('E');
  const [m, setM] = useState(() => {
    if (readyRef) readyRef.current.wordmark = eIdx < 0;
    return { prefixW: null, eW: null, capTop: null };
  });
  const patch = (p) => setM((prev) => ({ ...prev, ...p }));
  const ready = eIdx >= 0 && m.prefixW != null && m.eW != null && m.capTop != null;
  useEffect(() => {
    if (readyRef && ready) readyRef.current.wordmark = true;
  }, [ready, readyRef]);

  const textStyle = [
    { fontFamily, fontSize: size, color: COLORS.textPrimary, letterSpacing },
    lineHeight ? { lineHeight } : null,
  ];

  // Where the top of the capital letters sits inside the Text box, from the font metrics React
  // Native reports for the first line. (Accounts for extra leading when a larger lineHeight is set.)
  const onMainLayout = (e) => {
    const line = e.nativeEvent.lines && e.nativeEvent.lines[0];
    let capTop = null;
    if (line) {
      const asc = Math.abs(line.ascender);
      const cap = Math.abs(line.capHeight);
      const desc = Math.abs(line.descender);
      if (isFinite(asc) && isFinite(cap) && cap > 0 && asc >= cap) {
        const extra = isFinite(desc) ? Math.max(0, (line.height - (asc + desc)) / 2) : 0;
        capTop = (line.y || 0) + extra + asc - cap;
      }
    }
    if (capTop == null || capTop < 0) capTop = size * WORDMARK_BAR.capTopFallback;
    patch({ capTop });
  };

  let bar = null;
  if (ready) {
    const thickness = Math.max(1, size * WORDMARK_BAR.thickness);
    const eGlyphW = m.eW - letterSpacing; // measured widths include the spacing added after each letter
    const barWidth = eGlyphW * WORDMARK_BAR.widthOfE;
    const eCenter = m.prefixW - letterSpacing - eGlyphW / 2; // right edge of the E's glyph minus half its width
    bar = (
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: eCenter - barWidth / 2,
          top: m.capTop - size * WORDMARK_BAR.gap - thickness + size * WORDMARK_BAR.nudge,
          width: barWidth,
          height: thickness,
          backgroundColor: COLORS.primary,
        }}
      />
    );
  }

  return (
    <View style={[styles.wordmarkGroup, style]} accessible accessibilityLabel={APP_NAME}>
      <View style={[{ overflow: 'visible' }, offsetY ? { transform: [{ translateY: offsetY }] } : null]}>
        <Text style={textStyle} onTextLayout={onMainLayout}>{name}</Text>
        {bar}
        {/* Invisible copies of "…E" and "E", only to measure where the E sits. They are absolutely
            positioned and transparent, so they affect neither layout nor the letter spacing. */}
        {eIdx >= 0 && (
          <>
            <Text
              style={[textStyle, styles.wordmarkMeasure]}
              numberOfLines={1}
              importantForAccessibility="no-hide-descendants"
              onLayout={(e) => patch({ prefixW: e.nativeEvent.layout.width })}
            >
              {name.slice(0, eIdx + 1)}
            </Text>
            <Text
              style={[textStyle, styles.wordmarkMeasure]}
              numberOfLines={1}
              importantForAccessibility="no-hide-descendants"
              onLayout={(e) => patch({ eW: e.nativeEvent.layout.width })}
            >
              E
            </Text>
          </>
        )}
      </View>
      {!!APP_NAME_SUFFIX && <Text style={suffixStyle}>{APP_NAME_SUFFIX}</Text>}
    </View>
  );
}

// Top of the capital letters inside a Text box, from the first-line metrics React Native reports.
function lineCapTop(line, size) {
  if (line) {
    const asc = Math.abs(line.ascender);
    const cap = Math.abs(line.capHeight);
    const desc = Math.abs(line.descender);
    if (isFinite(asc) && isFinite(cap) && cap > 0 && asc >= cap) {
      const extra = isFinite(desc) ? Math.max(0, (line.height - (asc + desc)) / 2) : 0;
      const top = (line.y || 0) + extra + asc - cap;
      if (top >= 0) return top;
    }
  }
  return size * WORDMARK_BAR.capTopFallback;
}

// Variant with a large first letter and smaller remaining letters ("K" then "EPOS" at
// `smallCaps` x the size, e.g. 0.8), sharing one baseline. Two Text pieces means no kerning
// between the K and the E, which is invisible at this size. The bar sits over the small E.
function WordmarkSmallCaps({ size = 32, smallCaps = 0.8, fontFamily = 'Cinzel_700Bold', lineHeight, offsetY = 0, suffixStyle, style, letterSpacing = 0 }) {
  const name = APP_NAME.toUpperCase();
  const first = name.slice(0, 1);
  const rest = name.slice(1);
  const smallSize = Math.round(size * smallCaps * 10) / 10;
  const [m, setM] = useState({ x: null, y: null, eW: null, capTop: null });
  const patch = (p) => setM((prev) => ({ ...prev, ...p }));
  const ready = rest.startsWith('E') && m.x != null && m.y != null && m.eW != null && m.capTop != null;

  const base = { fontFamily, color: COLORS.textPrimary, letterSpacing };
  const bigStyle = [base, { fontSize: size }, lineHeight ? { lineHeight } : null];
  const smallStyle = [base, { fontSize: smallSize }, lineHeight ? { lineHeight: Math.round(lineHeight * smallCaps) } : null];

  let bar = null;
  if (ready) {
    const thickness = Math.max(1, size * WORDMARK_BAR.thickness);
    const eGlyphW = m.eW - letterSpacing;
    const barWidth = eGlyphW * WORDMARK_BAR.widthOfE;
    bar = (
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: m.x + eGlyphW / 2 - barWidth / 2,
          top: m.y + m.capTop - size * WORDMARK_BAR.gap - thickness + size * WORDMARK_BAR.nudge,
          width: barWidth,
          height: thickness,
          backgroundColor: COLORS.primary,
        }}
      />
    );
  }

  return (
    <View style={[styles.wordmarkGroup, style]} accessible accessibilityLabel={APP_NAME}>
      <View style={[{ overflow: 'visible' }, offsetY ? { transform: [{ translateY: offsetY }] } : null]}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
          <Text style={bigStyle}>{first}</Text>
          <Text
            style={smallStyle}
            onLayout={(e) => patch({ x: e.nativeEvent.layout.x, y: e.nativeEvent.layout.y })}
            onTextLayout={(e) => patch({ capTop: lineCapTop(e.nativeEvent.lines && e.nativeEvent.lines[0], smallSize) })}
          >
            {rest}
          </Text>
          {/* Invisible small "E", only to measure its width; takes no space. */}
          <Text
            style={[smallStyle, styles.wordmarkMeasure]}
            numberOfLines={1}
            importantForAccessibility="no-hide-descendants"
            onLayout={(e) => patch({ eW: e.nativeEvent.layout.width })}
          >
            E
          </Text>
          {bar}
        </View>
      </View>
      {!!APP_NAME_SUFFIX && <Text style={suffixStyle}>{APP_NAME_SUFFIX}</Text>}
    </View>
  );
}

// smallCaps: omit (or 1) for all letters the same size; e.g. 0.8 for a large first letter with
// the rest at 80%. fontFamily: omit for Cinzel Bold.
function Wordmark(props) {
  return props.smallCaps && props.smallCaps < 1 ? <WordmarkSmallCaps {...props} /> : <WordmarkSingle {...props} />;
}

const SUPABASE_URL = 'https://gwvgexyvonzqshbmviyv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_MAuofd7mk2GuD4YB1jqyGA_moBJ7Sw7';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

// The signed-in (anonymous) user's id, plus whether auth init has finished — provided by
// App() below. Screens read this instead of the old per-device id for anything user-specific
// (saves, notes, seen/ordering). userId is null until sign-in completes, and stays null
// indefinitely if it fails (e.g. offline) — everything downstream is written to treat a null
// userId as "skip this, don't crash" rather than assuming it will always be set.
const UserContext = React.createContext({
  userId: null, authReady: false, authUser: { email: null, isAnonymous: true }, signOutAndReset: async () => ({}),
});

// Lets a component deep inside a FlatList (ConceptCard, and anything it renders) trigger
// top-level screen navigation — e.g. "See all" on a card's conversation history opening the
// Conversations screen filtered to that card — without prop-drilling a navigate function
// through every screen that happens to render a ConceptCard. Provided once by App() below.
const NavContext = React.createContext({ openConversationsForConcept: () => {}, openShareByCode: async () => ({ ok: false }) });

// On web the app is a phone-width column (WEB_MAX_WIDTH), so every width-based size below uses the
// column width, not the whole browser window. On native this is exactly the window size, as before.
const WEB_MAX_WIDTH = 480;
const windowSize = Dimensions.get('window');
const height = windowSize.height;
const width = Platform.OS === 'web' ? Math.min(windowSize.width, WEB_MAX_WIDTH) : windowSize.width;
// Ceil'd to a whole pixel: a fractional height here is exactly the kind of value that trips
// Yoga's independent-edge pixel-grid rounding (see the lineHeight fix below), leaving a
// hairline sub-pixel gap between consecutive rows in the vertical paging FlatLists.
const CARD_HEIGHT = Math.ceil(height - 90);
const CARD_PAGE_HORIZONTAL_PADDING = 28;
const CARD_CONTENT_WIDTH = width - CARD_PAGE_HORIZONTAL_PADDING * 2;
const CARD_PAGE_TOP_PADDING = 4;
const CARD_PAGE_BOTTOM_BUFFER = 24;
// Off-state colour for the card's bottom action icons (on = COLORS.primary).
const CARD_ACTION_OFF = 'rgba(255,255,255,0.6)';
const EXPLANATION_LINE_HEIGHT = 24;
const HOOK_BLOCK_MARGIN = 24;
const PAGE_SIZE = 20;

const CATEGORY_LABELS = {
  cognitive_bias: 'Cognitive Bias',
  paradox: 'Paradox',
  thought_experiment: 'Thought Experiment',
  philosophy: 'Philosophy',
  physics: 'Physics',
  economics: 'Economics',
  psychology: 'Psychology',
  general_idea: 'Idea',
};

const COLORS = {
  bg: '#0E0F12',
  surface: '#1D1B18',
  surfaceRaised: '#262319',
  border: '#332E27',
  primary: '#B8860B',
  primaryText: '#0E0F12',
  success: '#4ade80',
  successBg: '#1f3d2b',
  error: '#ff6b6b',
  errorBg: '#3d1f1f',
  textPrimary: '#ffffff',
  textSecondary: '#c3c6d4',
  textTertiary: '#8A8D91',
  textMuted: '#5b5f72',
  danger: '#FF7A72',
  // Neutral dark, no warm/bronze tint — the third stop in every screen's LinearGradient
  // already uses this; sheets/popovers/bubbles that need a solid fill use it too, instead of
  // COLORS.surface/surfaceRaised (which lean brown).
  surfaceNeutral: '#1D1F24',
};

const CATEGORY_COLORS = {
  cognitive_bias: '#ff9d7a',
  paradox: '#c9b8ff',
  thought_experiment: '#8ec9ff',
  philosophy: '#e8c988',
  physics: '#7ee8d8',
  economics: '#7ee8a8',
  psychology: '#ff8ec9',
  general_idea: '#d8d8d8',
};

const TYPE = {
  hero: 32,
  title: 22,
  subtitle: 17,
  body: 15,
  caption: 13,
  micro: 11,
};

const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
};

// Native keeps the exact shadow it had; web gets the equivalent boxShadow (react-native-web warns on shadow* props).
const SHADOW = Platform.OS === 'web'
  ? { boxShadow: '0px 4px 8px rgba(26,18,10,0.3)' }
  : {
    shadowColor: '#1a120a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  };

let cachedDeviceId;
async function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    let id = await AsyncStorage.getItem('agora_device_id');
    if (!id) {
      id = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      await AsyncStorage.setItem('agora_device_id', id);
    }
    cachedDeviceId = id;
  } catch (e) {
    cachedDeviceId = `device_fallback_${Math.random().toString(36).slice(2, 10)}`;
  }
  return cachedDeviceId;
}

function pressableStyle(baseStyle) {
  const base = Array.isArray(baseStyle) ? baseStyle : [baseStyle];
  return ({ pressed }) => [...base, pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] }];
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function splitLongText(text, maxLen = 350) {
  if (!text) return [''];
  if (text.length <= maxLen) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLen && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

function pickTodayPuzzle(puzzles) {
  if (puzzles.length === 0) return null;
  const dayIndex = Math.floor(Date.now() / 86400000);
  return puzzles[dayIndex % puzzles.length];
}

function getNextCrosswordCell(puzzle, r, c) {
  let acrossWord = null, downWord = null;
  for (const w of puzzle.words) {
    if (w.direction === 'A' && w.row === r && c >= w.col && c < w.col + w.length) acrossWord = w;
    if (w.direction === 'D' && w.col === c && r >= w.row && r < w.row + w.length) downWord = w;
  }
  if (acrossWord) {
    const nc = c + 1;
    if (nc < acrossWord.col + acrossWord.length) return { r, c: nc };
  }
  if (downWord) {
    const nr = r + 1;
    if (nr < downWord.row + downWord.length) return { r: nr, c };
  }
  return null;
}

function numberCrossword(puzzle) {
  const starts = {};
  let counter = 1;
  const startCells = [];
  for (const w of puzzle.words) {
    const key = `${w.row},${w.col}`;
    if (!startCells.includes(key)) startCells.push(key);
  }
  startCells.sort((a, b) => {
    const [ar, ac] = a.split(',').map(Number);
    const [br, bc] = b.split(',').map(Number);
    return (ar - br) || (ac - bc);
  });
  startCells.forEach((key) => { starts[key] = counter++; });

  const across = puzzle.words
    .filter((w) => w.direction === 'A')
    .map((w) => ({ ...w, number: starts[`${w.row},${w.col}`] }))
    .sort((a, b) => a.number - b.number);
  const down = puzzle.words
    .filter((w) => w.direction === 'D')
    .map((w) => ({ ...w, number: starts[`${w.row},${w.col}`] }))
    .sort((a, b) => a.number - b.number);

  return { across, down, cellNumbers: starts };
}

function calcStreak(dates) {
  const set = new Set(dates);
  const cursor = new Date();
  const todayKey = cursor.toISOString().slice(0, 10);
  if (!set.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (set.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function splitExplanationIntoPages(lines, firstPageHeight, otherPageHeight, fallbackLineHeight) {
  if (!lines || lines.length === 0) return [''];
  const pages = [];
  let current = [];
  let currentHeight = 0;
  let limit = firstPageHeight;
  for (const line of lines) {
    const lineHeight = line.height || fallbackLineHeight;
    if (current.length > 0 && currentHeight + lineHeight > limit) {
      pages.push(current);
      current = [];
      currentHeight = 0;
      limit = otherPageHeight;
    }
    current.push(line);
    currentHeight += lineHeight;
  }
  if (current.length > 0) pages.push(current);
  return pages.map((pageLines) => pageLines.map((l) => l.text.trimEnd()).join(' ').trim());
}

// ---- Per-user card activity: views, time spent, page depth, saves ----
// Loaded once per user into this in-memory cache (ensureActivityLoaded). Screens read and
// write the cache directly for instant UI (star icon, unseen-first ordering), and pushes to
// Supabase happen in the background via upsert — see useCardActivity() below for exactly
// when those writes fire (not on every scroll frame).
let activityUserId = null;
let activityMap = new Map();
let activityLoadPromise = null;

function resetActivityCacheIfUserChanged(userId) {
  if (activityUserId !== userId) {
    activityUserId = userId;
    activityMap = new Map();
    activityLoadPromise = null;
  }
}

async function ensureActivityLoaded(userId) {
  if (!userId) return activityMap;
  resetActivityCacheIfUserChanged(userId);
  if (activityLoadPromise) return activityLoadPromise;
  activityLoadPromise = (async () => {
    const { data, error } = await supabase.from('card_activity').select('*').eq('user_id', userId);
    if (activityUserId !== userId) return activityMap; // user changed mid-load: drop stale rows
    if (error) {
      console.error('Failed to load card activity', error);
    } else if (data) {
      data.forEach((row) => {
        activityMap.set(row.concept_id, {
          viewCount: row.view_count || 0,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          timeSpentSeconds: row.time_spent_seconds || 0,
          maxPageReached: row.max_page_reached || 0,
          saved: !!row.saved,
          savedAt: row.saved_at,
          shareCount: row.share_count || 0,
          lastSharedAt: row.last_shared_at || null,
        });
      });
    }
    notifyActivityChange();
    return activityMap;
  })();
  return activityLoadPromise;
}

function getActivityEntry(conceptId) {
  return activityMap.get(conceptId) || null;
}

async function upsertActivityRow(userId, conceptId) {
  const entry = activityMap.get(conceptId);
  if (!entry || !userId) return;
  const row = {
    user_id: userId,
    concept_id: conceptId,
    first_seen_at: entry.firstSeenAt,
    last_seen_at: entry.lastSeenAt,
    view_count: entry.viewCount,
    time_spent_seconds: Math.round(entry.timeSpentSeconds || 0),
    max_page_reached: entry.maxPageReached || 0,
    saved: entry.saved,
    saved_at: entry.savedAt,
  };
  // Only sent once a card has actually been shared, so ordinary activity writes keep working
  // even if sharing.sql hasn't been run yet.
  if (entry.shareCount) {
    row.share_count = entry.shareCount;
    row.last_shared_at = entry.lastSharedAt;
  }
  const { error } = await supabase.from('card_activity').upsert(row, { onConflict: 'user_id,concept_id' });
  if (error) console.error('Failed to sync card activity', error);
}

// Background bookkeeping after a successful share: share_count + 1 and last_shared_at = now.
// Never throws and is never awaited by the share flow, so a failed write can't block sharing.
function recordShared(userId, conceptId) {
  try {
    if (!userId) return;
    const now = new Date().toISOString();
    const prev = activityMap.get(conceptId) || {
      viewCount: 0, timeSpentSeconds: 0, maxPageReached: 0, saved: false, savedAt: null, firstSeenAt: now, lastSeenAt: now,
    };
    activityMap.set(conceptId, { ...prev, shareCount: (prev.shareCount || 0) + 1, lastSharedAt: now });
    upsertActivityRow(userId, conceptId).catch(() => {});
  } catch (e) {
    console.error('Failed to record share', e);
  }
}

function recordCardSeen(userId, conceptId) {
  if (!userId) return;
  const now = new Date().toISOString();
  const prev = activityMap.get(conceptId) || {
    viewCount: 0, timeSpentSeconds: 0, maxPageReached: 0, saved: false, savedAt: null, firstSeenAt: now,
  };
  activityMap.set(conceptId, {
    ...prev,
    viewCount: prev.viewCount + 1,
    firstSeenAt: prev.firstSeenAt || now,
    lastSeenAt: now,
  });
}

function recordPageReached(conceptId, page) {
  const prev = activityMap.get(conceptId);
  if (!prev || page <= (prev.maxPageReached || 0)) return;
  activityMap.set(conceptId, { ...prev, maxPageReached: page });
}

function addTimeSpent(conceptId, seconds) {
  const prev = activityMap.get(conceptId);
  if (!prev) return;
  activityMap.set(conceptId, { ...prev, timeSpentSeconds: (prev.timeSpentSeconds || 0) + seconds });
}

function setSaved(userId, conceptId, saved) {
  if (!userId) return;
  const now = new Date().toISOString();
  const prev = activityMap.get(conceptId) || {
    viewCount: 0, timeSpentSeconds: 0, maxPageReached: 0, firstSeenAt: now, lastSeenAt: now,
  };
  activityMap.set(conceptId, { ...prev, saved, savedAt: saved ? now : prev.savedAt });
  notifyActivityChange();
  upsertActivityRow(userId, conceptId);
}

// Tiny hand-rolled pub-sub so components re-render when the activity cache changes (e.g. the
// star icon after a save) without threading state through every screen.
const activityListeners = new Set();
function notifyActivityChange() {
  activityListeners.forEach((fn) => fn());
}
// Drops every per-user in-memory cache — used when the signed-in user changes (sign in on a
// new device, sign out) so nothing from the previous user can show up for the next one.
function clearUserCaches() {
  activityUserId = null;
  activityMap = new Map();
  activityLoadPromise = null;
  notesUserId = null;
  notesMap = new Map();
  notesLoadPromise = null;
  myProfileUserId = null;
  myProfile = null;
  notifyActivityChange();
}
function useActivityVersion() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  }, []);
}

// Shared by every screen that shows a paging list of ConceptCards. A card counts as "seen"
// once it's been visible ~2s (a timer started/cleared from FlatList viewability, not scroll
// events); time spent accumulates from when it becomes visible to when it stops being visible,
// and that's also when the accumulated fields get flushed to Supabase — not on every frame.
function useCardActivity(userId) {
  useActivityVersion();
  const timersRef = useRef(new Map());

  const flushCard = useCallback((conceptId) => {
    const rec = timersRef.current.get(conceptId);
    if (!rec) return;
    clearTimeout(rec.seenTimeout);
    const elapsed = (Date.now() - rec.viewStartAt) / 1000;
    if (elapsed > 0) addTimeSpent(conceptId, elapsed);
    timersRef.current.delete(conceptId);
    upsertActivityRow(userId, conceptId);
  }, [userId]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      Array.from(timers.keys()).forEach(flushCard);
    };
  }, [flushCard]);

  const handleViewableItemsChanged = useCallback(({ changed }) => {
    Speech.stop();
    (changed || []).forEach((c) => {
      const id = c.item && c.item.id;
      if (!id) return;
      if (c.isViewable) {
        const seenTimeout = setTimeout(() => recordCardSeen(userId, id), 2000);
        timersRef.current.set(id, { viewStartAt: Date.now(), seenTimeout });
      } else {
        flushCard(id);
      }
    });
  }, [userId, flushCard]);

  const toggleSave = useCallback((concept) => {
    const entry = getActivityEntry(concept.id);
    setSaved(userId, concept.id, !(entry && entry.saved));
  }, [userId]);

  const isSaved = useCallback((conceptId) => {
    const entry = getActivityEntry(conceptId);
    return !!(entry && entry.saved);
  }, []);

  const onPageChange = useCallback((conceptId, page) => {
    recordPageReached(conceptId, page);
  }, []);

  return { handleViewableItemsChanged, toggleSave, isSaved, onPageChange };
}

// ---- Private per-user notes (never shown on the card itself) ----
// A card can have several separate notes (swipeable pages in the editor), so the cache is
// Map<conceptId, Array<{id, body, createdAt, updatedAt}>>, each array ordered oldest-to-newest
// (so .length-1 is "most recently added", matching the editor's default landing page).
let notesUserId = null;
let notesMap = new Map();
let notesLoadPromise = null;

function resetNotesCacheIfUserChanged(userId) {
  if (notesUserId !== userId) {
    notesUserId = userId;
    notesMap = new Map();
    notesLoadPromise = null;
  }
}

async function ensureNotesLoaded(userId) {
  if (!userId) return notesMap;
  resetNotesCacheIfUserChanged(userId);
  if (notesLoadPromise) return notesLoadPromise;
  notesLoadPromise = (async () => {
    const { data, error } = await supabase
      .from('notes')
      .select('id, concept_id, body, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (notesUserId !== userId) return notesMap; // user changed mid-load: drop stale rows
    if (error) {
      console.error('Failed to load notes', error);
    } else if (data) {
      data.forEach((row) => {
        const list = notesMap.get(row.concept_id) || [];
        list.push({ id: row.id, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at });
        notesMap.set(row.concept_id, list);
      });
    }
    return notesMap;
  })();
  return notesLoadPromise;
}

function getNotesForConcept(conceptId) {
  return notesMap.get(conceptId) || [];
}

async function createNote(userId, conceptId, body) {
  const trimmed = (body || '').trim();
  if (!userId || !trimmed) return { ok: false };
  const { data, error } = await supabase
    .from('notes')
    .insert({ user_id: userId, concept_id: conceptId, body: trimmed })
    .select('id, created_at, updated_at')
    .single();
  if (error) { console.error('Failed to create note', error); return { ok: false, error }; }
  const note = { id: data.id, body: trimmed, createdAt: data.created_at, updatedAt: data.updated_at };
  notesMap.set(conceptId, [...(notesMap.get(conceptId) || []), note]);
  return { ok: true, note };
}

async function updateNoteBody(userId, conceptId, noteId, body) {
  const trimmed = (body || '').trim();
  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from('notes').update({ body: trimmed, updated_at: updatedAt }).eq('id', noteId).eq('user_id', userId);
  if (error) { console.error('Failed to save note', error); return { ok: false, error }; }
  const list = notesMap.get(conceptId) || [];
  notesMap.set(conceptId, list.map((n) => (n.id === noteId ? { ...n, body: trimmed, updatedAt } : n)));
  return { ok: true, updatedAt };
}

async function deleteNoteById(userId, conceptId, noteId) {
  const { error } = await supabase.from('notes').delete().eq('id', noteId).eq('user_id', userId);
  if (error) { console.error('Failed to delete note', error); return { ok: false, error }; }
  const list = notesMap.get(conceptId) || [];
  notesMap.set(conceptId, list.filter((n) => n.id !== noteId));
  return { ok: true };
}

async function deleteAllNotesForConcept(userId, conceptId) {
  const { error } = await supabase.from('notes').delete().eq('user_id', userId).eq('concept_id', conceptId);
  if (error) { console.error('Failed to delete notes', error); return { ok: false, error }; }
  notesMap.set(conceptId, []);
  return { ok: true };
}

// One page's autosave target: creates the row on first non-empty save, updates it after that,
// and deletes it if emptied back out. `noteId` is null for a page that's never been saved yet.
async function saveNotePage(userId, conceptId, noteId, body) {
  if (!userId) return { ok: false, id: noteId };
  const trimmed = (body || '').trim();
  if (!trimmed) {
    if (!noteId) return { ok: true, id: null }; // never saved, nothing to delete
    const result = await deleteNoteById(userId, conceptId, noteId);
    return { ...result, id: null };
  }
  if (noteId) {
    const result = await updateNoteBody(userId, conceptId, noteId, trimmed);
    return { ...result, id: noteId };
  }
  const result = await createNote(userId, conceptId, trimmed);
  return result.ok ? { ok: true, id: result.note.id, updatedAt: result.note.updatedAt } : { ok: false, id: null };
}

// Same calendar date, no year — "28 Sep" — used in the My Notes/Conversations row timestamps
// and in the "## From my debate · 28 Sep" heading Part C appends to a note.
function formatShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

// Today -> a time ("2:45 PM"); this week -> a weekday ("Mon"); older -> a short date ("14 Sep").
function formatRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(startOfToday);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (d >= startOfToday) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  if (d >= sevenDaysAgo) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[d.getDay()];
  }
  return formatShortDate(iso);
}

// Buckets a list of {[dateField]: iso} items into TODAY / PREVIOUS 7 DAYS / EARLIER, newest
// first within each bucket (the query the caller used should already be ordered that way).
function bucketByDate(items, dateField) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(startOfToday);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const today = [], week = [], earlier = [];
  items.forEach((item) => {
    const d = new Date(item[dateField]);
    if (d >= startOfToday) today.push(item);
    else if (d >= sevenDaysAgo) week.push(item);
    else earlier.push(item);
  });
  return [
    { key: 'today', label: 'TODAY', items: today },
    { key: 'week', label: 'PREVIOUS 7 DAYS', items: week },
    { key: 'earlier', label: 'EARLIER', items: earlier },
  ].filter((section) => section.items.length > 0);
}

// Strips "## " heading markers and collapses line breaks into spaces, for one-line previews.
function previewFromBody(body) {
  return (body || '')
    .split('\n')
    .map((l) => (l.startsWith('## ') ? l.slice(3) : l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Renders a note body as formatted read-only text: "## " lines become small gold headings
// (the "## " itself hidden), everything else is plain body text. Used by NoteEditorScreen's
// read view once editing is done (see A1's formatting convention).
function NoteReadView(body) {
  const lines = (body || '').split('\n');
  return lines.map((line, i) => {
    if (line.startsWith('## ')) {
      return (
        <Text key={i} style={[styles.noteHeadingLine, i > 0 && { marginTop: 14 }]}>
          {line.slice(3)}
        </Text>
      );
    }
    if (!line.trim()) return <View key={i} style={{ height: 14 }} />;
    return (
      <Text key={i} style={styles.noteBodyLine}>
        {line}
      </Text>
    );
  });
}

const NOTE_STARTER_PROMPTS = ['Where have I seen this?', 'Do I agree? Why?', 'This connects to…'];

// Full-screen note editor (A1) — opened from a card's note icon (origin 'card') or from My
// Notes (origin 'notes'); the back label reflects where you'll land. Autosaves ~800ms after
// typing stops, on Done, on close, and when the app backgrounds; an emptied note is deleted
// (saveNoteForConcept already does that). Starts in edit mode with the keyboard up for an
// empty note, in read mode (tap to edit) for one with content.
// One page's editing/autosave — mounted once per note and kept alive while the horizontal
// pager it lives in is visible, so each page debounces and flushes independently. The parent
// (NoteEditorScreen) drives cross-page actions (copy, add-a-prompt, delete, done) through the
// imperative handle below, since only it knows which page is currently in view.
const NotePageEditor = React.forwardRef(function NotePageEditor(
  { note, concept, userId, autoFocusIfEmpty, onSaved, onStatusChange },
  ref
) {
  const [body, setBody] = useState(note.body || '');
  const [isEditing, setIsEditing] = useState(!note.body?.trim());
  const [showPrompts, setShowPrompts] = useState(false);
  const inputRef = useRef(null);
  const bodyRef = useRef(note.body || '');
  const noteIdRef = useRef(note.id);
  const saveTimerRef = useRef(null);
  const retryTimerRef = useRef(null);

  const reportStatus = (s) => onStatusChange && onStatusChange(note.key, s);

  const doSave = async (text) => {
    if (!userId) return;
    reportStatus('saving');
    const result = await saveNotePage(userId, concept.id, noteIdRef.current, text);
    if (result.ok) {
      noteIdRef.current = result.id;
      reportStatus(text.trim() ? 'saved' : null);
      onSaved && onSaved(note.key, { id: result.id, updatedAt: result.updatedAt });
    } else {
      reportStatus('retry');
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => doSave(bodyRef.current), 3000);
    }
  };

  const scheduleSave = (text) => {
    bodyRef.current = text;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => doSave(text), 800);
  };

  const flushSave = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      doSave(bodyRef.current);
    }
  };

  useEffect(() => {
    if (autoFocusIfEmpty && !bodyRef.current.trim()) {
      setTimeout(() => inputRef.current?.focus(), 350);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush on background (per A1) and on unmount (covers navigating away however it happens).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushSave();
    });
    return () => {
      sub.remove();
      flushSave();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    flush: flushSave,
    cancelPendingSave: () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    },
    copy: async () => {
      try { await Clipboard.setStringAsync(bodyRef.current); } catch (e) {}
    },
    showPromptsPanel: () => {
      setShowPrompts(true);
      setIsEditing(true);
      setTimeout(() => inputRef.current?.focus(), 50);
    },
  }));

  const handleChangeText = (text) => {
    setBody(text);
    scheduleSave(text);
  };

  const insertPrompt = (promptText) => {
    const needsBreak = body.trim().length > 0;
    const addition = `${needsBreak ? (body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n') : ''}## ${promptText}\n`;
    const next = body + addition;
    setBody(next);
    scheduleSave(next);
    setShowPrompts(false);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const hasContent = !!body.trim();
  const pillsVisible = !hasContent || showPrompts;

  return (
    <>
      {pillsVisible && (
        <View style={{ marginBottom: SPACING.md }}>
          <Text style={styles.noteStartWithLabel}>START WITH</Text>
          <View style={styles.notePillRow}>
            {NOTE_STARTER_PROMPTS.map((p) => (
              <Pressable key={p} onPress={() => insertPrompt(p)} style={pressableStyle(styles.notePill)}>
                <Text style={styles.notePillText}>{p}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {isEditing ? (
        <TextInput
          ref={inputRef}
          style={styles.noteWritingArea}
          multiline
          value={body}
          onChangeText={handleChangeText}
          onBlur={flushSave}
          placeholder="What does this make you think of?"
          placeholderTextColor={COLORS.textMuted}
        />
      ) : (
        <Pressable onPress={() => { setIsEditing(true); setTimeout(() => inputRef.current?.focus(), 50); }} style={styles.noteWritingArea}>
          {NoteReadView(body)}
        </Pressable>
      )}
    </>
  );
});

// Full-screen note editor (A1), now one horizontally-swipeable page per note on this card — a
// card can have several separate notes (its own free-write, one per saved debate debrief, etc)
// instead of everything piling into a single ever-growing note. "+" in the top bar adds a
// blank page; the card-context box up top is shared/fixed since every page is the same card.
function NoteEditorScreen({ visible, concept, userId, initialNoteId, onClose, onOpenCard, onNoteChanged }) {
  const [pages, setPages] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pageStatuses, setPageStatuses] = useState({});
  const scrollRef = useRef(null);
  const pageRefs = useRef({});

  const blankPage = () => ({ key: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, id: null, body: '', updatedAt: null });

  useEffect(() => {
    if (!visible || !concept || !userId) return;
    (async () => {
      setLoadingList(true);
      await ensureNotesLoaded(userId);
      let list = getNotesForConcept(concept.id).map((n) => ({ key: n.id, id: n.id, body: n.body, updatedAt: n.updatedAt }));
      if (list.length === 0) list = [blankPage()];
      setPages(list);
      setPageStatuses({});
      setMenuOpen(false);
      const startIndex = initialNoteId ? Math.max(0, list.findIndex((n) => n.id === initialNoteId)) : list.length - 1;
      setPageIndex(startIndex);
      setLoadingList(false);
      setTimeout(() => scrollRef.current?.scrollTo({ x: startIndex * width, animated: false }), 60);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, concept, userId, initialNoteId]);

  // These must stay above the `if (!concept) return null` below — every hook in this
  // component has to run on every render regardless of concept, or React loses track of
  // hook order between a null-concept render and a real one (this exact component is kept
  // mounted with concept toggling null<->object by callers like MyNotesScreen).
  const handleSaved = useCallback((key, meta) => {
    setPages((prev) => prev.map((p) => (p.key === key ? { ...p, id: meta.id, updatedAt: meta.updatedAt } : p)));
    onNoteChanged && onNoteChanged();
  }, [onNoteChanged]);

  const handleStatusChange = useCallback((key, status) => {
    setPageStatuses((prev) => ({ ...prev, [key]: status }));
  }, []);

  if (!concept) return null;

  const currentKey = () => pages[pageIndex] && pages[pageIndex].key;

  const handleClose = () => {
    const key = currentKey();
    if (key) pageRefs.current[key]?.flush();
    onClose();
  };

  const handleDone = () => {
    Keyboard.dismiss();
    const key = currentKey();
    if (key) pageRefs.current[key]?.flush();
  };

  const handleAddPage = () => {
    const key = currentKey();
    if (key) pageRefs.current[key]?.flush();
    const newPage = blankPage();
    setPages((prev) => {
      const next = [...prev, newPage];
      setTimeout(() => {
        scrollRef.current?.scrollTo({ x: (next.length - 1) * width, animated: true });
        setPageIndex(next.length - 1);
      }, 50);
      return next;
    });
  };

  const handleCopy = () => {
    setMenuOpen(false);
    const key = currentKey();
    if (key) pageRefs.current[key]?.copy();
  };

  const handleAddPromptFromMenu = () => {
    setMenuOpen(false);
    const key = currentKey();
    if (key) pageRefs.current[key]?.showPromptsPanel();
  };

  const handleDeleteCurrentPage = () => {
    setMenuOpen(false);
    const idx = pageIndex;
    const page = pages[idx];
    if (!page) return;
    Alert.alert('Delete note?', "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          pageRefs.current[page.key]?.cancelPendingSave();
          if (page.id) await deleteNoteById(userId, concept.id, page.id);
          setPages((prev) => {
            const next = prev.filter((_, i) => i !== idx);
            const finalList = next.length ? next : [blankPage()];
            const newIndex = Math.max(0, Math.min(idx, finalList.length - 1));
            setPageIndex(newIndex);
            setTimeout(() => scrollRef.current?.scrollTo({ x: newIndex * width, animated: false }), 50);
            return finalList;
          });
          onNoteChanged && onNoteChanged();
        },
      },
    ]);
  };

  const handleMomentumEnd = (e) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / width);
    setPageIndex(Math.max(0, Math.min(idx, pages.length - 1)));
  };

  const catColor = CATEGORY_COLORS[concept.category] || COLORS.textTertiary;
  const currentStatus = pages[pageIndex] ? pageStatuses[pages[pageIndex].key] : null;
  const saveStatusText =
    currentStatus === 'saving' ? 'Saving…' :
    currentStatus === 'saved' ? 'Saved just now' :
    currentStatus === 'retry' ? "Couldn't save, will retry" : '';

  return (
    <Modal visible={visible} animationType="slide" transparent={Platform.OS === 'web'} onRequestClose={handleClose}>
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        <RNSafeAreaView style={{ flex: 1 }}>
          <View style={styles.noteTopBar}>
            <Pressable onPress={handleClose} style={pressableStyle(styles.askHeaderBack)} hitSlop={8}>
              <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable onPress={handleAddPage} style={styles.noteMenuButton} hitSlop={8}>
              <Ionicons name="add" size={22} color={COLORS.primary} />
            </Pressable>
            <Pressable onPress={() => setMenuOpen((v) => !v)} style={styles.noteMenuButton} hitSlop={8}>
              <Text style={styles.noteMenuButtonText}>···</Text>
            </Pressable>
            <Pressable onPress={handleDone} style={{ paddingHorizontal: 10, paddingVertical: 8 }} hitSlop={8}>
              <Text style={styles.noteDoneText}>Done</Text>
            </Pressable>
          </View>

          {menuOpen && (
            <>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuOpen(false)} />
              <View style={[styles.noteMenuPopover, SHADOW]}>
                <Pressable
                  onPress={() => { setMenuOpen(false); onOpenCard && onOpenCard(); }}
                  style={styles.noteMenuItem}
                >
                  <Text style={styles.noteMenuItemText}>View full card</Text>
                </Pressable>
                <Pressable onPress={handleAddPromptFromMenu} style={styles.noteMenuItem}>
                  <Text style={styles.noteMenuItemText}>Add a prompt</Text>
                </Pressable>
                <Pressable onPress={handleCopy} style={styles.noteMenuItem}>
                  <Text style={styles.noteMenuItemText}>Copy note</Text>
                </Pressable>
                <View style={styles.noteMenuDivider} />
                <Pressable onPress={handleDeleteCurrentPage} style={styles.noteMenuItem}>
                  <Text style={[styles.noteMenuItemText, { color: COLORS.danger }]}>Delete note</Text>
                </Pressable>
              </View>
            </>
          )}

          <Pressable
            onPress={() => onOpenCard && onOpenCard()}
            style={pressableStyle([styles.noteCardContext, SHADOW, { marginHorizontal: SPACING.lg, marginTop: SPACING.sm }])}
          >
            <View style={styles.savedCardCategoryRow}>
              <View style={[styles.categoryDot, { backgroundColor: catColor }]} />
              <Text style={[styles.category, { color: catColor }]}>
                {CATEGORY_LABELS[concept.category] ?? concept.category}
              </Text>
            </View>
            <Text style={styles.noteCardContextTitle}>{concept.title}</Text>
            <Text style={styles.noteCardContextHook} numberOfLines={2}>{concept.hook}</Text>
            <Text style={styles.noteViewCardText}>View card ›</Text>
          </Pressable>

          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {loadingList ? (
              <View style={styles.center}>
                <ActivityIndicator color={COLORS.primary} size="large" />
              </View>
            ) : (
              <ScrollView
                ref={scrollRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={handleMomentumEnd}
                style={{ flex: 1 }}
              >
                {pages.map((page, i) => (
                  <ScrollView
                    key={page.key}
                    style={{ width }}
                    contentContainerStyle={styles.noteScreenContent}
                    keyboardShouldPersistTaps="handled"
                  >
                    <NotePageEditor
                      ref={(r) => { pageRefs.current[page.key] = r; }}
                      note={page}
                      concept={concept}
                      userId={userId}
                      autoFocusIfEmpty={i === pageIndex}
                      onSaved={handleSaved}
                      onStatusChange={handleStatusChange}
                    />
                  </ScrollView>
                ))}
              </ScrollView>
            )}

            {pages.length > 1 && (
              <View style={styles.noteDotsRow}>
                {pages.map((p, i) => (
                  <View key={p.key} style={[styles.pageDot, i === pageIndex && styles.pageDotActive]} />
                ))}
              </View>
            )}
            {!!saveStatusText && <Text style={styles.noteSaveStatus}>{saveStatusText}</Text>}
          </KeyboardAvoidingView>
        </RNSafeAreaView>
      </LinearGradient>
    </Modal>
  );
}

// ---- Ask Agora: three AI modes, via the ask-agora edge function ----
const ASK_AGORA_MODES = [
  { key: 'deeper', icon: 'telescope-outline', title: 'Go deeper', desc: 'More context, key thinkers, and nuance.' },
  { key: 'simple', icon: 'bulb-outline', title: 'Explain simply', desc: 'A plain-language explanation, with an analogy.' },
  { key: 'debate', icon: 'swap-horizontal-outline', title: 'Debate me', desc: `${APP_NAME} takes the other side — hold your ground.` },
  { key: 'explain', icon: 'chatbubble-ellipses-outline', title: 'Explain it back', desc: 'Say it in your own words and get coaching.' },
];
const ASK_AGORA_MODE_LABELS = Object.fromEntries(ASK_AGORA_MODES.map((m) => [m.key, m.title]));
// The edge function's display name ("ask-agora") and its real URL slug are two different
// things in Supabase — renaming the function later never changes the slug. Check
// Edge Functions > ask-agora > Settings > "Invoke function" for the actual slug if this
// function ever gets recreated, and update this one constant to match.
const ASK_AGORA_FUNCTION_SLUG = 'bright-api';

// Pulls the real error out of a failed supabase.functions.invoke() call — a FunctionsHttpError
// carries the edge function's actual JSON error body on `.context`, which is far more useful
// than the generic message supabase-js wraps it in. Shown directly in the UI (see errorMsg
// below) so a failure is diagnosable without needing to find the function's dashboard logs.
async function describeInvokeError(e) {
  try {
    if (e && e.context && typeof e.context.json === 'function') {
      const body = await e.context.json();
      if (body) {
        if (typeof body.error === 'string') return body.error;
        if (body.error) return JSON.stringify(body.error);
        if (body.message) return body.message;
        return JSON.stringify(body);
      }
    }
  } catch (_) {}
  return (e && e.message) ? e.message : String(e);
}

const ASK_AGORA_MODE_ICONS = Object.fromEntries(ASK_AGORA_MODES.map((m) => [m.key, m.icon]));

async function fetchConversationsForConcept(userId, conceptId, limit = 4) {
  if (!userId) return { conversations: [] };
  const { data, error } = await supabase
    .from('ai_conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('concept_id', conceptId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) return { error };
  return { conversations: data || [] };
}

async function fetchAllConversations(userId) {
  if (!userId) return { conversations: [] };
  const { data, error } = await supabase
    .from('ai_conversations')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) return { error };
  const conceptIds = Array.from(new Set((data || []).map((c) => c.concept_id)));
  if (conceptIds.length === 0) return { conversations: [] };
  const { data: concepts, error: cErr } = await supabase.from('concepts').select('id, title, category, hook').in('id', conceptIds);
  if (cErr) return { error: cErr };
  const byId = new Map((concepts || []).map((c) => [c.id, c]));
  const conversations = (data || []).map((c) => ({ ...c, concept: byId.get(c.concept_id) })).filter((c) => c.concept);
  return { conversations };
}

async function deleteConversationRow(id) {
  const { error } = await supabase.from('ai_conversations').delete().eq('id', id);
  return { ok: !error, error };
}

// Debate: the discussion question it was seeded with, if any — otherwise (and for every other
// mode) the first line of Claude's first reply, collapsed to one line.
function conversationPreviewText(conv) {
  if (conv.mode === 'debate' && conv.discussion_question) return conv.discussion_question;
  // Explain it back: the user's own (first) explanation.
  if (conv.mode === 'explain') {
    const firstUser = (conv.messages || []).find((m) => m.role === 'user');
    return firstUser ? previewFromBody(firstUser.content) : '';
  }
  const firstAssistant = (conv.messages || []).find((m) => m.role === 'assistant');
  return firstAssistant ? previewFromBody(firstAssistant.content) : '';
}

function AskAgoraModeSheet({ visible, onClose, onSelect, onOpenConversation, concept, userId }) {
  const [recentConversations, setRecentConversations] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const { openConversationsForConcept } = useContext(NavContext);

  useEffect(() => {
    if (!visible || !concept || !userId) {
      setRecentConversations([]);
      setHasMore(false);
      return;
    }
    (async () => {
      const { conversations } = await fetchConversationsForConcept(userId, concept.id, 4);
      const list = conversations || [];
      setRecentConversations(list.slice(0, 3));
      setHasMore(list.length > 3);
    })();
  }, [visible, concept, userId]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.noteSheet, SHADOW]}>
          <View style={styles.noteSheetHandle} />
          <Text style={styles.noteSheetTitle}>Ask {APP_NAME}</Text>

          {recentConversations.length > 0 && (
            <View>
              <Text style={styles.noteStartWithLabel}>YOUR CONVERSATIONS</Text>
              {recentConversations.map((c) => (
                <Pressable key={c.id} style={pressableStyle(styles.askConvoRow)} onPress={() => onOpenConversation(c)}>
                  <View style={styles.askModeIconWrap}>
                    <Ionicons name={ASK_AGORA_MODE_ICONS[c.mode]} size={18} color={COLORS.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.askConvoRowTitle}>{ASK_AGORA_MODE_LABELS[c.mode]}</Text>
                      <Text style={styles.askConvoRowDate}>· {formatRelativeTime(c.updated_at)}</Text>
                    </View>
                    <Text style={styles.askConvoRowPreview} numberOfLines={1}>{conversationPreviewText(c)}</Text>
                  </View>
                </Pressable>
              ))}
              {hasMore && (
                <Pressable
                  onPress={() => { onClose(); openConversationsForConcept(concept.id); }}
                  style={{ paddingVertical: 8 }}
                >
                  <Text style={styles.noteViewCardText}>See all</Text>
                </Pressable>
              )}
              <View style={styles.noteMenuDivider} />
            </View>
          )}

          {ASK_AGORA_MODES.map((m) => (
            <Pressable key={m.key} style={pressableStyle(styles.askModeRow)} onPress={() => onSelect(m.key)}>
              <View style={styles.askModeIconWrap}>
                <Ionicons name={m.icon} size={20} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.askModeTitle}>{m.title}</Text>
                <Text style={styles.askModeDesc}>{m.desc}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

// ---- Explain it back: the user explains a card's idea from memory and gets coaching ----
// Served by the same edge function (mode 'explain'). A session is an ai_conversations row with
// mode = 'explain': messages alternate [attempt, feedback, attempt, feedback, ...], the latest
// feedback is also in the `debrief` column, and debrief_saved_at records "Save to my note".
const EXPLAIN_MIN_CHARS = 20;
const EXPLAIN_MAX_CHARS = 1200;
const EXPLAIN_HEADINGS = ['What you got right', 'What you missed', 'Say it like this', 'Try it on someone'];

// Splits the function's reply into its four headed sections. Tolerates "Heading: text" on one
// line and stray markdown symbols; falls back to showing the whole reply as one block.
function parseExplainFeedback(text) {
  const sections = [];
  let current = null;
  String(text || '').split('\n').forEach((raw) => {
    const line = raw.trim().replace(/^[#*\s]+/, '');
    const heading = EXPLAIN_HEADINGS.find((h) => line.toLowerCase().startsWith(h.toLowerCase()));
    if (heading) {
      const rest = line.slice(heading.length).replace(/^[*:\s—–-]+/, '').replace(/[*]+$/, '').trim();
      current = { heading, body: rest ? [rest] : [] };
      sections.push(current);
    } else if (current) {
      current.body.push(raw);
    }
  });
  const parsed = sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() })).filter((s) => s.body);
  return parsed.length ? parsed : [{ heading: null, body: String(text || '').trim() }];
}

function explainAttemptsFromMessages(messages) {
  const attempts = [];
  let pending = null;
  (messages || []).forEach((m) => {
    if (m.role === 'user') pending = { text: m.content, feedback: null };
    else if (m.role === 'assistant' && pending) {
      pending.feedback = m.content;
      attempts.push(pending);
      pending = null;
    }
  });
  return attempts;
}

// existingConversation: an ai_conversations row to reopen read-only (from Library or a card's
// conversation list). onSeeCard: optional; closes this screen and then opens the card.
function ExplainItBackScreen({ visible, concept, existingConversation, userId, onClose, onNoteChanged, onSeeCard }) {
  const [phase, setPhase] = useState('write'); // write | loading | feedback
  const [text, setText] = useState('');
  const [attempts, setAttempts] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [limitReached, setLimitReached] = useState(null);
  const [savingToNote, setSavingToNote] = useState(false);
  const [noteEditorVisible, setNoteEditorVisible] = useState(false);
  const [savedNoteId, setSavedNoteId] = useState(null);
  const readOnly = !!existingConversation;

  useEffect(() => {
    if (!visible) return;
    if (existingConversation) {
      const a = explainAttemptsFromMessages(existingConversation.messages);
      setAttempts(a);
      setConversationId(existingConversation.id);
      setSavedAt(existingConversation.debrief_saved_at || null);
      setPhase(a.length ? 'feedback' : 'write');
    } else {
      setAttempts([]);
      setConversationId(null);
      setSavedAt(null);
      setPhase('write');
    }
    setText('');
    setErrorMsg(null);
    setLimitReached(null);
    setSavingToNote(false);
    setSavedNoteId(null);
  }, [visible, existingConversation]);

  if (!concept) return null;

  const catColor = CATEGORY_COLORS[concept.category] || COLORS.textTertiary;
  const trimmedLength = text.trim().length;
  const canCheck = trimmedLength >= EXPLAIN_MIN_CHARS && !limitReached;

  const handleCheck = async () => {
    if (!canCheck) return;
    const attemptText = text.trim();
    // Earlier attempts and their feedback ride along so a repeat attempt can say what improved.
    const history = attempts.flatMap((a) => [
      { role: 'user', content: a.text },
      { role: 'assistant', content: a.feedback },
    ]);
    setPhase('loading');
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke(ASK_AGORA_FUNCTION_SLUG, {
        body: {
          concept_id: concept.id,
          mode: 'explain',
          messages: [...history, { role: 'user', content: attemptText }],
          conversation_id: conversationId || undefined,
        },
      });
      if (error) throw error;
      if (data.limit_reached) {
        // Same message the other AI modes show. The text stays in the box.
        setLimitReached(data.message);
        setPhase('write');
        return;
      }
      setConversationId(data.conversation_id);
      setAttempts((prev) => [...prev, { text: attemptText, feedback: data.reply }]);
      setSavedAt(null);
      setText('');
      setPhase('feedback');
    } catch (e) {
      const detail = await describeInvokeError(e);
      setErrorMsg(`Couldn't check that: ${detail}`);
      setPhase('write');
    }
  };

  const handleSaveToNote = async () => {
    const latest = attempts[attempts.length - 1];
    if (!latest || !userId || savingToNote || savedAt) return;
    setSavingToNote(true);
    try {
      // Same flow as saving a debate debrief: its own note page, no summary line — just the
      // four sections under a heading.
      const sections = parseExplainFeedback(latest.feedback);
      const body = `## Explain it back\n${sections.map((s) => (s.heading ? `${s.heading}\n${s.body}` : s.body)).join('\n\n')}`;
      const result = await createNote(userId, concept.id, body);
      if (result.ok) {
        const when = new Date().toISOString();
        if (conversationId) {
          await supabase.from('ai_conversations').update({ debrief_saved_at: when }).eq('id', conversationId);
        }
        setSavedAt(when);
        setSavedNoteId(result.note.id);
        onNoteChanged && onNoteChanged();
      }
    } finally {
      setSavingToNote(false);
    }
  };

  const handleTryAgain = () => {
    setText('');
    setErrorMsg(null);
    setLimitReached(null);
    setPhase('write');
  };

  const handleSeeCard = () => {
    onClose();
    if (onSeeCard) onSeeCard();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={Platform.OS === 'web'} onRequestClose={onClose}>
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        <RNSafeAreaView style={{ flex: 1 }}>
          <ScreenHeader title="Explain it back" backLabel="Back" onBack={onClose} collapsed={false} />
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={styles.explainContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {/* Only the category and title — the explanation, example and hook stay hidden. */}
              <View style={styles.categoryRow}>
                <View style={[styles.categoryDot, { backgroundColor: catColor }]} />
                <Text style={[styles.category, { color: catColor }]}>{CATEGORY_LABELS[concept.category] ?? concept.category}</Text>
              </View>
              <Text style={styles.explainTitle}>{concept.title}</Text>

              {phase === 'write' && (
                <View>
                  <Text style={styles.explainGuidance}>Explain this as if to a friend who has never heard of it.</Text>
                  <TextInput
                    style={styles.explainInput}
                    value={text}
                    onChangeText={(t) => { setText(t); setErrorMsg(null); }}
                    placeholder="In your own words…"
                    placeholderTextColor={COLORS.textMuted}
                    multiline
                    textAlignVertical="top"
                    maxLength={EXPLAIN_MAX_CHARS}
                    editable={!limitReached}
                  />
                  <Text style={styles.explainCounter}>{text.length}/{EXPLAIN_MAX_CHARS.toLocaleString('en-US')}</Text>
                  <Text style={styles.explainTip}>Tap the microphone on your keyboard to say it aloud.</Text>
                  {!!limitReached && <Text style={styles.askLimitText}>{limitReached}</Text>}
                  {!!errorMsg && <Text style={styles.askErrorText}>{errorMsg}</Text>}
                  <Pressable
                    style={pressableStyle([styles.primaryButton, { marginTop: SPACING.md }, !canCheck && { opacity: 0.4 }])}
                    onPress={handleCheck}
                    disabled={!canCheck}
                  >
                    <Text style={styles.primaryButtonText}>Check my explanation</Text>
                  </Pressable>
                  {attempts.length > 0 && (
                    <Pressable onPress={() => setPhase('feedback')} style={pressableStyle(styles.secureLink)}>
                      <Text style={[styles.secureLinkText, { color: COLORS.textTertiary }]}>Back to my feedback</Text>
                    </Pressable>
                  )}
                </View>
              )}

              {phase === 'loading' && (
                <View style={{ alignItems: 'center', paddingVertical: SPACING.xxl }}>
                  <ActivityIndicator color={COLORS.primary} size="large" />
                  <Text style={[styles.explainTip, { marginTop: SPACING.md }]}>Reading your explanation…</Text>
                </View>
              )}

              {phase === 'feedback' && (
                <View>
                  {attempts.map((a, i) => (
                    <View key={i} style={{ marginBottom: SPACING.md }}>
                      {attempts.length > 1 && <Text style={styles.groupSectionLabel}>{`Attempt ${i + 1}`}</Text>}
                      <View style={styles.askBubbleUserWrap}>
                        <View style={[styles.askBubbleUser, { maxWidth: '100%' }]}>
                          <Text style={styles.askBubbleUserText}>{a.text}</Text>
                        </View>
                      </View>
                      <View style={[styles.askBubbleAssistant, styles.askBubbleDebrief, { maxWidth: '100%', alignSelf: 'stretch' }]}>
                        {parseExplainFeedback(a.feedback).map((s, k) => (
                          <View key={k} style={{ marginBottom: 12 }}>
                            {!!s.heading && <Text style={styles.askDebriefLabel}>{s.heading}</Text>}
                            <Text style={styles.askBubbleAssistantText}>{s.body}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}

                  <Pressable
                    style={pressableStyle([styles.askSecondaryButton, savedAt && { opacity: 0.8 }])}
                    onPress={savedAt ? undefined : handleSaveToNote}
                    disabled={savingToNote || !!savedAt}
                  >
                    {savedAt ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="checkmark" size={16} color={COLORS.success} />
                        <Text style={styles.askSecondaryButtonText}>Saved to note</Text>
                      </View>
                    ) : (
                      <Text style={styles.askSecondaryButtonText}>{savingToNote ? 'Saving…' : 'Save to my note'}</Text>
                    )}
                  </Pressable>
                  {!!savedAt && !!savedNoteId && (
                    <Pressable onPress={() => setNoteEditorVisible(true)} style={{ alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
                      <Text style={styles.noteViewCardText}>View note</Text>
                    </Pressable>
                  )}
                  {!readOnly && (
                    <Pressable style={pressableStyle(styles.askSecondaryButton)} onPress={handleTryAgain}>
                      <Text style={styles.askSecondaryButtonText}>Try again</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={handleSeeCard} style={pressableStyle(styles.secureLink)}>
                    <Text style={styles.secureLinkText}>See the card</Text>
                  </Pressable>
                </View>
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        </RNSafeAreaView>
      </LinearGradient>

      <NoteEditorScreen
        visible={noteEditorVisible}
        concept={concept}
        userId={userId}
        initialNoteId={savedNoteId}
        onClose={() => setNoteEditorVisible(false)}
        onOpenCard={() => { setNoteEditorVisible(false); handleSeeCard(); }}
        onNoteChanged={onNoteChanged}
      />
    </Modal>
  );
}

// Every caller keeps using AskAgoraConversation; 'explain' gets its own screen, everything
// else (go deeper, explain simply, debate) is the unchanged chat below.
function AskAgoraConversation(props) {
  return props.mode === 'explain' ? <ExplainItBackScreen {...props} /> : <AskAgoraChat {...props} />;
}

// Full-screen conversation view for a chosen mode. Owns its own thread state — deeper/simple
// start immediately with Claude's first answer, debate starts with Claude's opening question —
// and calls the ask-agora edge function via supabase.functions.invoke, which sends the current
// session automatically so the function can verify who's asking. Pass `existingConversation`
// (a full ai_conversations row) to reopen a past one instead of starting fresh — see B3/B4.
function AskAgoraChat({ visible, mode, concept, discussionQuestion, existingConversation, userId, onClose, onNoteChanged, onSeeCard }) {
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [limitReached, setLimitReached] = useState(null);
  const [debriefShown, setDebriefShown] = useState(false);
  const [debriefSavedAt, setDebriefSavedAt] = useState(null);
  const [savingToNote, setSavingToNote] = useState(false);
  const [noteEditorVisible, setNoteEditorVisible] = useState(false);
  const [savedNoteId, setSavedNoteId] = useState(null);
  const scrollRef = useRef(null);

  const startFresh = useCallback(async () => {
    setMessages([]);
    setConversationId(null);
    setInput('');
    setErrorMsg(null);
    setLimitReached(null);
    setDebriefShown(false);
    setDebriefSavedAt(null);
    setLoadingInitial(true);
    try {
      const { data, error } = await supabase.functions.invoke(ASK_AGORA_FUNCTION_SLUG, {
        body: {
          concept_id: concept.id,
          mode,
          messages: [],
          discussion_question: discussionQuestion || undefined,
        },
      });
      if (error) throw error;
      if (data.limit_reached) {
        setLimitReached(data.message);
      } else {
        setConversationId(data.conversation_id);
        setMessages([{ role: 'assistant', content: data.reply }]);
      }
    } catch (e) {
      const detail = await describeInvokeError(e);
      setErrorMsg(`Couldn't start this conversation: ${detail}`);
    } finally {
      setLoadingInitial(false);
    }
  }, [concept, mode, discussionQuestion]);

  useEffect(() => {
    if (!visible || !mode) return;
    if (existingConversation) {
      setMessages(existingConversation.messages || []);
      setConversationId(existingConversation.id);
      setDebriefShown(existingConversation.status === 'ended');
      setDebriefSavedAt(existingConversation.debrief_saved_at || null);
      setInput('');
      setErrorMsg(null);
      setLimitReached(null);
      setSavingToNote(false);
      setLoadingInitial(false);
      return;
    }
    startFresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode, existingConversation]);

  const handleSaveDebriefToNote = async () => {
    if (!concept || !userId || savingToNote || debriefSavedAt) return;
    const debriefMsg = messages[messages.length - 1];
    const debriefTextContent = debriefMsg ? debriefMsg.content : '';
    setSavingToNote(true);
    try {
      // Its own separate note page, not appended onto whatever else is already there — that's
      // exactly the "one giant growing note" problem multiple notes-per-card exists to avoid.
      const heading = `## From my debate · ${formatShortDate(new Date().toISOString())}`;
      const body = `${heading}\n${debriefTextContent}`;
      const result = await createNote(userId, concept.id, body);
      if (result.ok) {
        const savedAt = new Date().toISOString();
        if (conversationId) {
          await supabase.from('ai_conversations').update({ debrief_saved_at: savedAt }).eq('id', conversationId);
        }
        setDebriefSavedAt(savedAt);
        setSavedNoteId(result.note.id);
        onNoteChanged && onNoteChanged();
      }
    } finally {
      setSavingToNote(false);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || limitReached || (mode === 'debate' && debriefShown)) return;
    const outgoing = [...messages, { role: 'user', content: text }];
    setSending(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke(ASK_AGORA_FUNCTION_SLUG, {
        body: {
          concept_id: concept.id,
          mode,
          messages: outgoing,
          discussion_question: discussionQuestion || undefined,
          conversation_id: conversationId || undefined,
        },
      });
      if (error) throw error;
      if (data.limit_reached) {
        // The message did send — just no reply. Show it and stop, don't lose it or the error path's input.
        setLimitReached(data.message);
        setMessages(outgoing);
        setInput('');
        return;
      }
      setConversationId(data.conversation_id);
      setMessages([...outgoing, { role: 'assistant', content: data.reply }]);
      setInput(''); // only cleared on confirmed success — a failed send leaves it untouched below
      if (data.debrief) setDebriefShown(true);
    } catch (e) {
      const detail = await describeInvokeError(e);
      setErrorMsg(`Couldn't send: ${detail}`);
    } finally {
      setSending(false);
    }
  };

  const handleEndDebate = async () => {
    if (sending || debriefShown || limitReached) return;
    setSending(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke(ASK_AGORA_FUNCTION_SLUG, {
        body: {
          concept_id: concept.id,
          mode,
          messages,
          discussion_question: discussionQuestion || undefined,
          conversation_id: conversationId || undefined,
          end_debate: true,
        },
      });
      if (error) throw error;
      if (data.limit_reached) {
        setLimitReached(data.message);
        return;
      }
      setConversationId(data.conversation_id);
      setMessages([...messages, { role: 'assistant', content: data.reply }]);
      setDebriefShown(true);
    } catch (e) {
      const detail = await describeInvokeError(e);
      setErrorMsg(`Couldn't end the debate: ${detail}`);
    } finally {
      setSending(false);
    }
  };

  const handleNewDebate = () => {
    startFresh();
  };

  const debateEnded = mode === 'debate' && debriefShown;
  const inputDisabled = sending || !!limitReached || debateEnded;

  return (
    <Modal visible={visible} animationType="slide" transparent={Platform.OS === 'web'} onRequestClose={onClose}>
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        <RNSafeAreaView style={{ flex: 1 }}>
          <View style={styles.askHeaderBar}>
            <Pressable onPress={onClose} style={pressableStyle(styles.askHeaderBack)} hitSlop={8}>
              <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
            </Pressable>
            {mode === 'debate' && !debriefShown && !limitReached && (
              <Pressable onPress={handleEndDebate} style={pressableStyle({})} hitSlop={8}>
                <Text style={styles.askEndDebateText}>End debate</Text>
              </Pressable>
            )}
          </View>
          <View style={styles.askHeaderTitleBlock}>
            <Text style={styles.askHeaderTitle} numberOfLines={1}>{concept.title}</Text>
            <Text style={styles.askHeaderMode}>{ASK_AGORA_MODE_LABELS[mode]}</Text>
          </View>

          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {loadingInitial ? (
              <View style={styles.center}>
                <ActivityIndicator color={COLORS.primary} size="large" />
              </View>
            ) : (
              <ScrollView
                ref={scrollRef}
                style={{ flex: 1 }}
                contentContainerStyle={styles.askMessagesContent}
                onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
              >
                {messages.map((m, i) => {
                  if (m.role === 'user') {
                    return (
                      <View key={i} style={styles.askBubbleUserWrap}>
                        <View style={styles.askBubbleUser}>
                          <Text style={styles.askBubbleUserText}>{m.content}</Text>
                        </View>
                      </View>
                    );
                  }
                  const isDebrief = mode === 'debate' && debriefShown && i === messages.length - 1;
                  return (
                    <View key={i} style={[styles.askBubbleAssistant, isDebrief && styles.askBubbleDebrief]}>
                      {isDebrief && <Text style={styles.askDebriefLabel}>Debrief</Text>}
                      <Text style={styles.askBubbleAssistantText}>{m.content}</Text>
                    </View>
                  );
                })}
                {sending && (
                  <View style={styles.askBubbleAssistant}>
                    <ActivityIndicator color={COLORS.textTertiary} size="small" />
                  </View>
                )}
                {limitReached && <Text style={styles.askLimitText}>{limitReached}</Text>}
                {errorMsg && <Text style={styles.askErrorText}>{errorMsg}</Text>}
              </ScrollView>
            )}

            {debateEnded ? (
              <View style={styles.askEndedActions}>
                <Pressable
                  style={pressableStyle([styles.askSecondaryButton, debriefSavedAt && { opacity: 0.8 }])}
                  onPress={debriefSavedAt ? undefined : handleSaveDebriefToNote}
                  disabled={savingToNote || !!debriefSavedAt}
                >
                  {debriefSavedAt ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Ionicons name="checkmark" size={16} color={COLORS.success} />
                      <Text style={styles.askSecondaryButtonText}>Saved to note</Text>
                    </View>
                  ) : (
                    <Text style={styles.askSecondaryButtonText}>{savingToNote ? 'Saving…' : 'Save to my note'}</Text>
                  )}
                </Pressable>
                {debriefSavedAt && (
                  <Pressable onPress={() => setNoteEditorVisible(true)} style={{ alignItems: 'center', paddingVertical: 6 }}>
                    <Text style={styles.noteViewCardText}>View note</Text>
                  </Pressable>
                )}
                <Pressable style={pressableStyle(styles.askSecondaryButton)} onPress={handleNewDebate}>
                  <Text style={styles.askSecondaryButtonText}>New debate on this card</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.askInputRow}>
                <TextInput
                  style={styles.askInput}
                  value={input}
                  onChangeText={setInput}
                  placeholder={inputDisabled ? '' : 'Ask a follow-up…'}
                  placeholderTextColor={COLORS.textMuted}
                  multiline
                  editable={!inputDisabled}
                />
                <Pressable
                  onPress={handleSend}
                  disabled={inputDisabled || !input.trim()}
                  style={pressableStyle([styles.askSendButton, (inputDisabled || !input.trim()) && { opacity: 0.4 }])}
                >
                  <Ionicons name="arrow-up" size={18} color={COLORS.primaryText} />
                </Pressable>
              </View>
            )}
          </KeyboardAvoidingView>
        </RNSafeAreaView>
      </LinearGradient>

      <NoteEditorScreen
        visible={noteEditorVisible}
        concept={concept}
        userId={userId}
        initialNoteId={savedNoteId}
        onClose={() => setNoteEditorVisible(false)}
        // "View card": leave the note and the conversation and show the card (when this was opened from a card, closing is enough: you are already on it).
        onOpenCard={() => { setNoteEditorVisible(false); onClose(); if (onSeeCard) onSeeCard(); }}
        onNoteChanged={onNoteChanged}
      />
    </Modal>
  );
}

function ConceptCard({ concept, saved, onToggleSave, onPageScrollChange, cardHeight, onPageChange }) {
  const resolvedCardHeight = cardHeight != null ? cardHeight : CARD_HEIGHT;
  const { userId } = useContext(UserContext);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageAreaHeight, setPageAreaHeight] = useState(null);
  const [hookHeight, setHookHeight] = useState(null);
  const [explanationLines, setExplanationLines] = useState(null);
  const [exampleAngleHeight, setExampleAngleHeight] = useState(null);
  const [noteEditorVisible, setNoteEditorVisible] = useState(false);
  // Bumped after a note is loaded/saved/deleted to force a re-read of getNotesForConcept()
  // below — notes live in the module-level cache, not React state.
  const [, setNoteVersion] = useState(0);
  const [askAgoraVisible, setAskAgoraVisible] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [activeAskMode, setActiveAskMode] = useState(null);
  const [debateSeedQuestion, setDebateSeedQuestion] = useState(null);
  const [activeConversation, setActiveConversation] = useState(null);

  const bumpNoteVersion = useCallback(() => setNoteVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (userId) {
      ensureNotesLoaded(userId).then(() => { if (!cancelled) setNoteVersion((v) => v + 1); });
    }
    return () => { cancelled = true; };
  }, [userId]);

  // Reports the furthest horizontal page reached, for card_activity.max_page_reached.
  useEffect(() => {
    onPageChange && onPageChange(concept.id, pageIndex);
  }, [concept.id, pageIndex]);

  const hasNote = getNotesForConcept(concept.id).length > 0;

  const translateX = useRef(new Animated.Value(0)).current;
  const pageIndexRef = useRef(0);
  const pagesLengthRef = useRef(1);

  const handleListen = async () => {
    if (isSpeaking) {
      Speech.stop();
      setIsSpeaking(false);
      return;
    }
    const text = `${concept.title}. ${concept.hook} ${concept.explanation}`;
    const voiceId = await getBestVoiceId();
    setIsSpeaking(true);
    Speech.speak(text, {
      rate: 1.1,
      voice: voiceId,
      onDone: () => setIsSpeaking(false),
      onStopped: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });
  };

  const catColor = CATEGORY_COLORS[concept.category] || COLORS.textTertiary;
  const hasAngle = !!concept.conversation_angle;
  const hasExample = !!(concept.example && concept.example.trim());
  const hasQuestions = !!(concept.discussion_question || concept.discussion_question_2 || concept.discussion_question_3);

  // The example tries to share a page with the conversation angle (measured via onLayout on
  // their shared wrapper). If that combined content doesn't fit the available page area, the
  // example gets split off onto its own page instead — same "measure, then decide" pattern
  // already proven for the explanation pagination above, just deciding page count rather than
  // slicing text.
  const availableAngleHeight = pageAreaHeight != null ? pageAreaHeight - CARD_PAGE_TOP_PADDING - CARD_PAGE_BOTTOM_BUFFER : null;
  const splitExampleAngle = !!(
    hasExample && hasAngle && exampleAngleHeight != null && availableAngleHeight != null &&
    exampleAngleHeight > availableAngleHeight
  );
  const showExampleOnAnglePage = hasExample && hasAngle && !splitExampleAngle;
  const showExampleOwnPage = hasExample && (!hasAngle || splitExampleAngle);

  // Explanation text is measured via the visible Text's own onTextLayout (first firing only,
  // see below) and sliced at real rendered line boundaries, then spread across as many
  // horizontal pages as it needs. Until measured, show it unsplit so there's no blank first frame.
  const explanationPages = useMemo(() => {
    if (!explanationLines || pageAreaHeight == null || hookHeight == null) {
      return [concept.explanation || ''];
    }
    const usableHeight = pageAreaHeight - CARD_PAGE_TOP_PADDING - CARD_PAGE_BOTTOM_BUFFER;
    const firstPageHeight = Math.max(EXPLANATION_LINE_HEIGHT, usableHeight - (hookHeight + HOOK_BLOCK_MARGIN));
    const otherPageHeight = Math.max(EXPLANATION_LINE_HEIGHT, usableHeight);
    return splitExplanationIntoPages(explanationLines, firstPageHeight, otherPageHeight, EXPLANATION_LINE_HEIGHT);
  }, [explanationLines, pageAreaHeight, hookHeight, concept.explanation]);

  const pages = ['main'];
  for (let i = 1; i < explanationPages.length; i++) pages.push(`exp-${i}`);
  if (showExampleOwnPage) pages.push('example');
  if (hasAngle) pages.push('angle');
  if (hasQuestions) pages.push('questions');

  pageIndexRef.current = pageIndex;
  pagesLengthRef.current = pages.length;

  const lockOuter = () => onPageScrollChange && onPageScrollChange(false);
  const unlockOuter = () => onPageScrollChange && onPageScrollChange(true);

  // Manual horizontal paging (instead of a horizontal ScrollView) — a horizontal ScrollView
  // nested inside the outer vertical paging FlatList was producing a card whose reported layout
  // height didn't match what actually painted on screen for one specific list position, clipping
  // the explanation text well short of the space it measured as having. Driving translateX
  // ourselves sidesteps ScrollView's own content-size/paging resolution entirely.
  const animateToPage = (targetIndex) => {
    setPageIndex(targetIndex);
    Animated.spring(translateX, {
      toValue: -targetIndex * width,
      useNativeDriver: false,
      bounciness: 4,
    }).start(() => unlockOuter());
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (evt, gestureState) =>
        Math.abs(gestureState.dx) > 8 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5,
      onPanResponderGrant: () => {
        lockOuter();
        translateX.stopAnimation();
        translateX.setOffset(-pageIndexRef.current * width);
        translateX.setValue(0);
      },
      onPanResponderMove: Animated.event([null, { dx: translateX }], { useNativeDriver: false }),
      onPanResponderRelease: (evt, gestureState) => {
        translateX.flattenOffset();
        const currentIndex = pageIndexRef.current;
        const lastIndex = pagesLengthRef.current - 1;
        let targetIndex = currentIndex;
        if (gestureState.dx < -width * 0.25 || gestureState.vx < -0.5) {
          targetIndex = Math.min(currentIndex + 1, lastIndex);
        } else if (gestureState.dx > width * 0.25 || gestureState.vx > 0.5) {
          targetIndex = Math.max(currentIndex - 1, 0);
        }
        animateToPage(targetIndex);
      },
      onPanResponderTerminate: () => {
        translateX.flattenOffset();
        animateToPage(pageIndexRef.current);
      },
    })
  ).current;

  const onHookTextLayout = (e) => {
    const lines = e.nativeEvent.lines;
    const h = lines.length ? lines[lines.length - 1].y + lines[lines.length - 1].height : 0;
    setHookHeight(h);
  };

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={[styles.card, { height: resolvedCardHeight }]}>
      <View style={styles.cardFixedHeader}>
        <View style={styles.categoryRow}>
          <View style={[styles.categoryDot, { backgroundColor: catColor }]} />
          <Text style={[styles.category, { color: catColor }]}>
            {CATEGORY_LABELS[concept.category] ?? concept.category}
          </Text>
        </View>
        <Text style={styles.title} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}>{concept.title}</Text>
      </View>

      <View
        style={[{ flex: 1, overflow: 'hidden' }, Platform.OS === 'web' && { touchAction: 'pan-y' }]}
        onLayout={(e) => setPageAreaHeight(e.nativeEvent.layout.height)}
        {...panResponder.panHandlers}
      >
        <Animated.View
          style={{
            flexDirection: 'row',
            width: width * pages.length,
            height: pageAreaHeight != null ? pageAreaHeight : resolvedCardHeight,
            transform: [{ translateX }],
          }}
        >
          {pages.map((page) => (
            <View key={page} style={{ width, height: pageAreaHeight != null ? pageAreaHeight : resolvedCardHeight }}>
              {page === 'main' && (
                <View style={styles.cardPageContent}>
                  <Text style={styles.hook} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE} onTextLayout={onHookTextLayout}>{concept.hook}</Text>
                  <Text
                    style={styles.explanation}
                    maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}
                    onTextLayout={(e) => {
                      // Only capture the FIRST measurement, taken while this Text is still
                      // showing the full unsplit explanation (the fallback before pagination
                      // kicks in). Once explanationPages[0] becomes a shorter slice, later
                      // onTextLayout firings reflect that slice, not the full text — ignore them.
                      if (explanationLines == null) {
                        setExplanationLines(e.nativeEvent.lines);
                      }
                    }}
                  >
                    {explanationPages[0]}
                  </Text>
                </View>
              )}
              {page.startsWith('exp-') && (
                <View style={styles.cardPageContent}>
                  <Text style={styles.explanation} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}>{explanationPages[Number(page.slice(4))]}</Text>
                </View>
              )}
              {page === 'example' && (
                <View style={styles.cardPageContent}>
                  <Text style={styles.pageHeading}>For example</Text>
                  <Text style={styles.exampleLarge} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}>{concept.example}</Text>
                </View>
              )}
              {page === 'angle' && (
                <View style={styles.cardPageContent}>
                  {showExampleOnAnglePage ? (
                    <View
                      onLayout={(e) => {
                        if (exampleAngleHeight == null) setExampleAngleHeight(e.nativeEvent.layout.height);
                      }}
                    >
                      <Text style={styles.pageHeading}>For example</Text>
                      <Text style={styles.exampleLarge} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}>{concept.example}</Text>
                      <Text style={styles.pageHeading}>In conversation</Text>
                      <Text style={styles.angleLarge} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}>{concept.conversation_angle}</Text>
                    </View>
                  ) : (
                    <>
                      <Text style={styles.pageHeading}>In conversation</Text>
                      <Text style={styles.angleLarge} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}>{concept.conversation_angle}</Text>
                    </>
                  )}
                </View>
              )}
              {page === 'questions' && (
                <View style={styles.cardPageContent}>
                  <Text style={styles.pageHeading}>💬 Ask your friends</Text>
                  {[concept.discussion_question, concept.discussion_question_2, concept.discussion_question_3]
                    .filter(Boolean)
                    .map((q, i) => (
                      <View key={i} style={styles.debateQuestionBlock}>
                        <Text style={[styles.discussionTextLarge, { marginBottom: 6 }]} maxFontSizeMultiplier={CARD_MAX_FONT_SCALE}>• {q}</Text>
                        <Pressable
                          onPress={() => { setDebateSeedQuestion(q); setActiveAskMode('debate'); }}
                          style={pressableStyle(styles.debateLinkWrap)}
                          hitSlop={6}
                        >
                          <Ionicons name="swap-horizontal-outline" size={13} color={COLORS.primary} />
                          <Text style={styles.debateLinkText}>Debate this</Text>
                        </Pressable>
                      </View>
                    ))}
                </View>
              )}
            </View>
          ))}
        </Animated.View>
      </View>

      <View style={styles.cardActionRow}>
        <Pressable onPress={handleListen} style={pressableStyle(styles.cardActionButton)}>
          <Ionicons
            name={isSpeaking ? 'stop' : 'volume-high-outline'}
            size={24}
            color={isSpeaking ? COLORS.primary : CARD_ACTION_OFF}
          />
        </Pressable>
        <Pressable onPress={() => setNoteEditorVisible(true)} style={pressableStyle(styles.cardActionButton)}>
          <Ionicons
            name={hasNote ? 'document-text' : 'document-text-outline'}
            size={24}
            color={hasNote ? COLORS.primary : CARD_ACTION_OFF}
          />
        </Pressable>
        <Pressable onPress={onToggleSave} style={pressableStyle(styles.cardActionButton)}>
          <Ionicons
            name={saved ? 'bookmark' : 'bookmark-outline'}
            size={24}
            color={saved ? COLORS.primary : CARD_ACTION_OFF}
          />
        </Pressable>
        <Pressable onPress={() => setShareVisible(true)} style={pressableStyle(styles.cardActionButton)}>
          <Ionicons name="share-outline" size={24} color={CARD_ACTION_OFF} />
        </Pressable>
        <Pressable onPress={() => setAskAgoraVisible(true)} style={pressableStyle(styles.cardActionButton)}>
          <Ionicons name="sparkles-outline" size={24} color={COLORS.primary} />
        </Pressable>
      </View>

      {pages.length > 1 && (
        <View style={styles.pageDots}>
          {pages.map((_, i) => (
            <View key={i} style={[styles.pageDot, i === pageIndex && styles.pageDotActive]} />
          ))}
        </View>
      )}

      <NoteEditorScreen
        visible={noteEditorVisible}
        concept={concept}
        userId={userId}
        onClose={() => setNoteEditorVisible(false)}
        onOpenCard={() => setNoteEditorVisible(false)}
        onNoteChanged={bumpNoteVersion}
      />

      <ShareSheet visible={shareVisible} concept={concept} onClose={() => setShareVisible(false)} />

      <AskAgoraModeSheet
        visible={askAgoraVisible}
        onClose={() => setAskAgoraVisible(false)}
        concept={concept}
        userId={userId}
        onSelect={(m) => { setActiveAskMode(m); setActiveConversation(null); setAskAgoraVisible(false); setDebateSeedQuestion(null); }}
        onOpenConversation={(conv) => {
          setActiveAskMode(conv.mode);
          setActiveConversation(conv);
          setDebateSeedQuestion(conv.discussion_question || null);
          setAskAgoraVisible(false);
        }}
      />
      <AskAgoraConversation
        visible={!!activeAskMode}
        mode={activeAskMode}
        concept={concept}
        userId={userId}
        discussionQuestion={debateSeedQuestion}
        existingConversation={activeConversation}
        onNoteChanged={bumpNoteVersion}
        onClose={() => { setActiveAskMode(null); setDebateSeedQuestion(null); setActiveConversation(null); }}
      />
    </LinearGradient>
  );
}


function FeedScreen({ category, onBack, backLabel = 'Back' }) {
  const { userId } = useContext(UserContext);
  const [concepts, setConcepts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [outerScrollEnabled, setOuterScrollEnabled] = useState(true);
  // Measured directly instead of trusting CARD_HEIGHT's height-90 guess: any mismatch between
  // a card's own height and the FlatList's true viewport is invisible on middle items (there's
  // slack to scroll past) but strands the LAST item short of its snap position, revealing the
  // previous card underneath it.
  const [listHeight, setListHeight] = useState(CARD_HEIGHT);
  const { handleViewableItemsChanged, toggleSave, isSaved, onPageChange } = useCardActivity(userId);
  const webPager = useWebPager(listHeight);

  useEffect(() => {
    (async () => {
      let query = supabase.from('concepts').select('*');
      if (category) query = query.eq('category', category);
      const [{ data, error }] = await Promise.all([query, ensureActivityLoaded(userId)]);
      if (error) {
        setErrorMsg(JSON.stringify(error, null, 2));
        setLoading(false);
        return;
      }
      // Unseen cards first (randomized), then anything already seen, least-recently-seen first.
      const withEntry = (data || []).map((c) => ({ c, entry: getActivityEntry(c.id) }));
      const unseen = shuffle(withEntry.filter((x) => !x.entry || !x.entry.viewCount).map((x) => x.c));
      const seen = withEntry
        .filter((x) => x.entry && x.entry.viewCount)
        .sort((a, b) => new Date(a.entry.lastSeenAt || 0) - new Date(b.entry.lastSeenAt || 0))
        .map((x) => x.c);
      setConcepts([...unseen, ...seen]);
      setLoading(false);
    })();
  }, [category, userId]);

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="" backLabel={backLabel} onBack={onBack} collapsed={false} />
      {/* The list area is measured on its own (below the nav row), so listHeight is the true
          height each card gets. */}
      <View style={{ flex: 1 }} onLayout={(e) => setListHeight(Math.ceil(e.nativeEvent.layout.height))}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#e8c988" size="large" /></View>
      ) : errorMsg ? (
        <View style={styles.center}>
          <Text style={{ color: '#ff6b6b', fontSize: 13, fontFamily: 'monospace' }}>{errorMsg}</Text>
        </View>
      ) : concepts.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>No cards in this category yet.</Text>
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={concepts}
          keyExtractor={(item) => item.id}
          getItemLayout={(data, i) => ({ length: listHeight, offset: listHeight * i, index: i })}
          scrollEnabled={outerScrollEnabled}
          pagingEnabled
          bounces={false}
          showsVerticalScrollIndicator={false}
          snapToInterval={listHeight}
          decelerationRate="fast"
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
          {...webPagerListProps(true)}
          {...(Platform.OS === 'web' ? { onScroll: webPager.onScroll, scrollEventThrottle: 16, extraData: webPager.activeIndex, initialNumToRender: concepts.length, maxToRenderPerBatch: concepts.length, windowSize: concepts.length * 2 + 1, removeClippedSubviews: false } : {})}
          renderItem={({ item, index }) => webSnapItem(
            Platform.OS === 'web' && Math.abs(index - webPager.activeIndex) > 2 ? (
              <View style={{ height: listHeight }} />
            ) : (
              <ConceptCard
                concept={item}
                saved={isSaved(item.id)}
                onToggleSave={() => toggleSave(item)}
                onPageScrollChange={setOuterScrollEnabled}
                onPageChange={onPageChange}
                cardHeight={listHeight}
              />
            )
          )}
        />
      )}
      </View>
    </View>
  );
}

// Purely global and deterministic on purpose: every user must see the same 3 cards on the
// same day, so this can't depend on any per-user state (seen/unseen, activity, etc.) — that
// would make it both different-per-user and liable to shift intraday as that state changes.
function pickDailyThree(allConcepts) {
  if (allConcepts.length === 0) return [];
  const dayIndex = Math.floor(Date.now() / 86400000);
  const n = allConcepts.length;
  const start = (dayIndex * 3) % n;
  const picks = [];
  for (let i = 0; i < Math.min(3, n); i++) {
    picks.push(allConcepts[(start + i) % n]);
  }
  return picks;
}

function DailyThreeScreen({ onBack, backLabel = 'Back' }) {
  const { userId } = useContext(UserContext);
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [outerScrollEnabled, setOuterScrollEnabled] = useState(true);
  const [listHeight, setListHeight] = useState(CARD_HEIGHT);
  const { handleViewableItemsChanged, toggleSave, isSaved, onPageChange } = useCardActivity(userId);

  useEffect(() => {
    (async () => {
      // pickDailyThree itself is purely global (same 3 cards for everyone, see its comment);
      // loading activity here is just so isSaved() below already has this user's star state
      // by the time the cards render, not to influence which cards get picked.
      const [{ data, error }] = await Promise.all([
        supabase.from('concepts').select('*').order('created_at', { ascending: true }),
        ensureActivityLoaded(userId),
      ]);
      if (error) {
        setErrorMsg(JSON.stringify(error, null, 2));
        setLoading(false);
        return;
      }
      setCards(pickDailyThree(data || []));
      setLoading(false);
    })();
  }, [userId]);

  const header = <ScreenHeader title="" backLabel={backLabel} onBack={onBack} collapsed={false} />;

  if (loading) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} size="large" />
        </View>
      </LinearGradient>
    );
  }

  if (errorMsg) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        {header}
        <View style={styles.center}>
          <Text style={{ color: COLORS.error, fontSize: 13, fontFamily: 'monospace' }}>{errorMsg}</Text>
        </View>
      </LinearGradient>
    );
  }

  if (cards.length === 0) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        {header}
        <View style={styles.center}>
          <Text style={styles.emptyText}>No cards available yet.</Text>
        </View>
      </LinearGradient>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {header}
      <View style={{ flex: 1 }} onLayout={(e) => setListHeight(Math.ceil(e.nativeEvent.layout.height))}>
      <FlatList
        style={{ flex: 1 }}
        data={cards}

        keyExtractor={(item) => item.id}
        getItemLayout={(data, i) => ({ length: listHeight, offset: listHeight * i, index: i })}
        scrollEnabled={outerScrollEnabled}
        pagingEnabled
        bounces={false}
        showsVerticalScrollIndicator={false}
        snapToInterval={listHeight}
        decelerationRate="fast"
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
        {...webPagerListProps(true)}
        renderItem={({ item }) => webSnapItem(
          <ConceptCard
            concept={item}
            saved={isSaved(item.id)}
            onToggleSave={() => toggleSave(item)}
            onPageScrollChange={setOuterScrollEnabled}
            onPageChange={onPageChange}
            cardHeight={listHeight}
          />
        )}
      />
      </View>
    </View>
  );
}

function QuizScreen({ onBack, backLabel = 'Back' }) {
  const [loading, setLoading] = useState(true);
  const [alreadyTaken, setAlreadyTaken] = useState(false);
  const [pastResult, setPastResult] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [completed, setCompleted] = useState(false);
  const [expandedReview, setExpandedReview] = useState(null);
  const popAnim = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    (async () => {
            const deviceId = await getDeviceId();
      const { data: existing, error: existingErr } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('quiz_date', todayStr())
        .eq('device_id', deviceId)
        .limit(1);
      if (!existingErr && existing && existing.length > 0) {
        setPastResult(existing[0]);
        setAlreadyTaken(true);
        setLoading(false);
        return;
      }
      const { data: qs, error: qErr } = await supabase
        .from('quiz_questions')
        .select('*, concept:concepts(*)');
      if (qErr || !qs || qs.length === 0) {
        setLoading(false);
        return;
      }
      setQuestions(shuffle(qs).slice(0, 5));
      setLoading(false);
    })();
  }, []);

    const handleSelect = (letter) => {
    if (selectedOption) return;
    setSelectedOption(letter);
    const isCorrect = letter === questions[currentIndex].correct_option;
    if (isCorrect) {
      popAnim.setValue(1);
      Animated.sequence([
        Animated.timing(popAnim, { toValue: 1.06, duration: 120, useNativeDriver: true }),
        Animated.spring(popAnim, { toValue: 1, friction: 4, useNativeDriver: true }),
      ]).start();
    } else {
      shakeAnim.setValue(0);
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 1, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -1, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 1, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
      ]).start();
    }
  };

  const handleNext = async () => {
    const q = questions[currentIndex];
    const isCorrect = selectedOption === q.correct_option;
    const newAnswers = [...answers, { question: q, selected: selectedOption, isCorrect }];
    setAnswers(newAnswers);

    const isLast = currentIndex === questions.length - 1;
    if (isLast) {
      const finalScore = newAnswers.filter((a) => a.isCorrect).length;
            const deviceId = await getDeviceId();
      await supabase.from('quiz_results').insert({ quiz_date: todayStr(), score: finalScore, total: questions.length, device_id: deviceId });
      setCompleted(true);
    } else {
      setCurrentIndex((i) => i + 1);
      setSelectedOption(null);
    }
  };

  const BackLink = () => (
    <Pressable onPress={onBack} style={pressableStyle([styles.backButton, styles.backButtonRow])}>
      <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
      <Text style={styles.backButtonText}>{backLabel}</Text>
    </Pressable>
  );

  if (loading) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <ActivityIndicator color={COLORS.primary} size="large" />
      </LinearGradient>
    );
  }

  if (alreadyTaken) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <Ionicons name="checkmark-circle" size={56} color={COLORS.success} style={{ marginBottom: 16 }} />
        <Text style={styles.resultText}>Today's quiz is done</Text>
        <Text style={styles.resultScore}>{pastResult.score} / {pastResult.total}</Text>
        <Text style={styles.emptyText}>Come back tomorrow for a new one.</Text>
      </LinearGradient>
    );
  }

  if (questions.length === 0) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <Text style={styles.emptyText}>No quiz questions yet.</Text>
      </LinearGradient>
    );
  }

  if (completed) {
    const score = answers.filter((a) => a.isCorrect).length;
    return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        <BackLink />
        <ScrollView contentContainerStyle={styles.quizContainer}>
          <Ionicons name="trophy" size={56} color={COLORS.primary} style={{ marginBottom: 16, alignSelf: 'center' }} />
          <Text style={[styles.resultText, { textAlign: 'center' }]}>Quiz complete</Text>
          <Text style={[styles.resultScore, { textAlign: 'center' }]}>{score} / {questions.length}</Text>
          <Text style={[styles.groupSectionLabel, { marginTop: 24, textAlign: 'center' }]}>Review</Text>

          {answers.map((a, idx) => {
            const isOpen = expandedReview === idx;
            const c = a.question.concept;
            return (
              <View key={idx} style={[styles.reviewCard, SHADOW]}>
                <Pressable onPress={() => setExpandedReview(isOpen ? null : idx)} style={styles.reviewHeader}>
                  <Ionicons
                    name={a.isCorrect ? 'checkmark-circle' : 'close-circle'}
                    size={20}
                    color={a.isCorrect ? COLORS.success : COLORS.error}
                    style={{ marginRight: 10 }}
                  />
                  <Text style={styles.reviewQuestion} numberOfLines={isOpen ? undefined : 2}>
                    {a.question.question}
                  </Text>
                </Pressable>
                {isOpen && c && (
                  <View style={styles.reviewBody}>
                    <Text style={styles.reviewConceptTitle}>{c.title}</Text>
                    <Text style={styles.reviewConceptText}>{c.explanation}</Text>
                    <Text style={styles.angleLabel}>In conversation</Text>
                    <Text style={styles.angle}>{c.conversation_angle}</Text>
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      </LinearGradient>
    );
  }

  const q = questions[currentIndex];
  const options = [
    ['a', q.option_a], ['b', q.option_b], ['c', q.option_c], ['d', q.option_d],
  ];

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <BackLink />
      <ScrollView contentContainerStyle={styles.quizContainer}>
        <Text style={styles.quizProgress}>Question {currentIndex + 1} of {questions.length}</Text>
        <Text style={styles.questionText}>{q.question}</Text>

                {options.map(([letter, text]) => {
          let optStyle = styles.optionButton;
          if (selectedOption) {
            if (letter === q.correct_option) optStyle = styles.optionButtonCorrect;
            else if (letter === selectedOption) optStyle = styles.optionButtonWrong;
          }
          const isSelected = letter === selectedOption;
          const shakeTranslate = shakeAnim.interpolate({ inputRange: [-1, 1], outputRange: [-6, 6] });
          const animStyle = isSelected
            ? { transform: [{ scale: letter === q.correct_option ? popAnim : 1 }, { translateX: letter === q.correct_option ? 0 : shakeTranslate }] }
            : {};
          return (
            <Pressable key={letter} style={pressableStyle(optStyle)} onPress={() => handleSelect(letter)}>
              <Animated.View style={isSelected ? animStyle : undefined}>
                <Text style={styles.optionText}>{text}</Text>
              </Animated.View>
            </Pressable>
          );
        })}

        {selectedOption && (
          <>
            {q.concept?.hook && <Text style={styles.emojiRevealHook}>{q.concept.hook}</Text>}
            <Pressable style={pressableStyle([styles.nextButton, SHADOW])} onPress={handleNext}>
              <Text style={styles.nextButtonText}>
                {currentIndex === questions.length - 1 ? 'Finish' : 'Next'}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={COLORS.primaryText} />
            </Pressable>
          </>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

// ---- Shared header for My Notes, Conversations, Saved and Quiz History ----
// Three pieces that together make the one header, so all four screens match exactly:
//   ScreenHeader      the fixed navigation row: back control, a small centred title that fades
//                     in once the large title has scrolled away, and an optional right action
//                     (an outline gold icon that opens a small popover menu).
//   ScreenTitleBlock  the large Cinzel title, plus the optional search field directly beneath
//                     it. Goes in the list's header, so it scrolls away with the content.
//   useCollapsingTitle  tracks the list's scroll position -> `collapsed`.
const SORT_OPTIONS = [
  { key: 'recent', label: 'Most recent' },
  { key: 'category', label: 'Category' },
  { key: 'az', label: 'A–Z' },
];

function useCollapsingTitle(threshold = 40) {
  const [collapsed, setCollapsed] = useState(false);
  const onScroll = useCallback((e) => {
    const next = e.nativeEvent.contentOffset.y > threshold;
    setCollapsed((prev) => (prev === next ? prev : next));
  }, [threshold]);
  return { collapsed, onScroll };
}

// action: { icon, items: [{ key, label }], selectedKey, onSelect(key) } — omit for none.
function ScreenHeader({ title, backLabel, onBack, collapsed, action, compact }) {
  const fade = useRef(new Animated.Value(0)).current;
  const buttonRef = useRef(null);
  const [menuAnchor, setMenuAnchor] = useState(null);

  useEffect(() => {
    Animated.timing(fade, { toValue: collapsed ? 1 : 0, duration: 160, useNativeDriver: true }).start();
  }, [collapsed, fade]);

  const openMenu = () => {
    if (!buttonRef.current) return;
    buttonRef.current.measureInWindow((x, y, w, h) => {
      setMenuAnchor({ top: y + h + 4, right: Math.max(SPACING.sm, width - (x + w)) });
    });
  };
  const closeMenu = () => setMenuAnchor(null);

  return (
    <View style={[styles.screenNavRow, compact && styles.screenNavRowCompact]}>
      {onBack ? (
        <Pressable onPress={onBack} style={pressableStyle(styles.screenBackButton)} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
          <Text style={styles.backButtonText}>{backLabel}</Text>
        </Pressable>
      ) : (
        // Tab screens (Learn, Games, Library, Profile) have no back control.
        <View style={styles.screenBackButton} />
      )}

      <Animated.Text pointerEvents="none" numberOfLines={1} style={[styles.screenCollapsedTitle, compact && styles.screenCollapsedTitleCompact, { opacity: fade }]}>
        {title}
      </Animated.Text>

      {action ? (
        <Pressable ref={buttonRef} collapsable={false} onPress={openMenu} hitSlop={compact ? 4 : 0} style={pressableStyle([styles.screenActionButton, compact && styles.screenActionButtonCompact])}>
          <Ionicons name={action.icon} size={24} color={COLORS.primary} />
        </Pressable>
      ) : (
        <View style={[styles.screenActionButton, compact && styles.screenActionButtonCompact]} />
      )}

      {action && (
        <Modal visible={!!menuAnchor} transparent animationType="fade" onRequestClose={closeMenu}>
          <View style={{ flex: 1 }}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeMenu} />
            {menuAnchor && (
              <View style={[styles.noteMenuPopover, SHADOW, { top: menuAnchor.top, right: menuAnchor.right }]}>
                {action.items.map((item) => (
                  <Pressable
                    key={item.key}
                    onPress={() => { closeMenu(); action.onSelect(item.key); }}
                    style={[styles.noteMenuItem, styles.screenMenuItemRow]}
                  >
                    <Text style={styles.noteMenuItemText}>{item.label}</Text>
                    {action.selectedKey === item.key && <Ionicons name="checkmark" size={18} color={COLORS.primary} />}
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </Modal>
      )}
    </View>
  );
}

// search: { value, onChangeText, placeholder } — omit for a screen with no search.
function ScreenTitleBlock({ title, search }) {
  return (
    <View>
      <Text style={[styles.homeTitle, { marginBottom: SPACING.md }]}>{title}</Text>
      {search && (
        <View style={styles.screenSearchField}>
          <Ionicons name="search" size={18} color={COLORS.textTertiary} />
          <TextInput
            style={styles.searchInput}
            placeholder={search.placeholder}
            placeholderTextColor={COLORS.textMuted}
            value={search.value}
            onChangeText={search.onChangeText}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search.value.length > 0 && (
            <Pressable onPress={() => search.onChangeText('')}>
              <Ionicons name="close-circle" size={18} color={COLORS.textTertiary} />
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// Groups already-recency-ordered items for the My Notes / Conversations section lists.
// 'recent' keeps the TODAY / PREVIOUS 7 DAYS / EARLIER buckets; 'category' groups by card
// category; 'az' groups by the first letter of the card title.
function groupBySort(items, sortKey, getCategory, getTitle) {
  if (sortKey === 'category') {
    const byCat = new Map();
    items.forEach((item) => {
      const k = getCategory(item);
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k).push(item);
    });
    return Array.from(byCat.entries())
      .map(([k, list]) => ({ key: `cat-${k}`, label: CATEGORY_LABELS[k] ?? k, items: list }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  if (sortKey === 'az') {
    const sorted = [...items].sort((a, b) => getTitle(a).localeCompare(getTitle(b)));
    const byLetter = new Map();
    sorted.forEach((item) => {
      const letter = (getTitle(item)[0] || '#').toUpperCase();
      if (!byLetter.has(letter)) byLetter.set(letter, []);
      byLetter.get(letter).push(item);
    });
    return Array.from(byLetter.entries()).map(([letter, list]) => ({ key: `az-${letter}`, label: letter, items: list }));
  }
  return bucketByDate(items, 'updated_at');
}

function ScreenTransition({ children }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 320,
      useNativeDriver: true,
    }).start();
  }, []);

  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] });

  return (
    <Animated.View style={{ flex: 1, opacity: anim, transform: [{ translateX }] }}>
      {children}
    </Animated.View>
  );
}

function QuizHistoryScreen({ onBack, backLabel = 'Back' }) {
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);
  const { collapsed, onScroll } = useCollapsingTitle();

  useEffect(() => {
    (async () => {
            const deviceId = await getDeviceId();
      const { data, error } = await supabase
        .from('quiz_results')
        .select('*')
        .eq('device_id', deviceId)
        .order('quiz_date', { ascending: false })
        .limit(30);
      if (!error && data) setResults(data);
      setLoading(false);
    })();
  }, []);

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <ScreenHeader title="Quiz History" backLabel={backLabel} onBack={onBack} collapsed={collapsed} />
      <ScrollView contentContainerStyle={styles.screenListContent} onScroll={onScroll} scrollEventThrottle={16}>
        <ScreenTitleBlock title="Quiz History" />
        {loading ? (
          <ActivityIndicator color={COLORS.primary} size="large" style={{ marginTop: 20 }} />
        ) : results.length === 0 ? (
          <Text style={styles.emptyText}>No quizzes taken yet.</Text>
        ) : (
          <>
            {results.map((r) => (
              <View key={r.id} style={[styles.historyRow, SHADOW]}>
                <Text style={styles.historyDate}>{r.quiz_date}</Text>
                <Text style={styles.historyScore}>{r.score} / {r.total}</Text>
              </View>
            ))}
            <Text style={styles.screenCountFooter}>
              {results.length} quiz{results.length === 1 ? '' : 'zes'}
            </Text>
          </>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

function CrosswordScreen({ onBack, backLabel = 'Back' }) {
  const [loading, setLoading] = useState(true);
  const [puzzle, setPuzzle] = useState(null);
  const [inputs, setInputs] = useState([]);
  const [checked, setChecked] = useState(false);
  const inputRefs = useRef({});

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('crossword_puzzles')
        .select('*')
        .order('puzzle_index', { ascending: true });
      if (!error && data && data.length > 0) {
        const p = pickTodayPuzzle(data);
        setPuzzle(p);
        setInputs(p.grid.map((row) => row.map(() => '')));
      }
      setLoading(false);
    })();
  }, []);

    const setCell = (r, c, val) => {
    const letter = val.toUpperCase().slice(-1).replace(/[^A-Z]/g, '');
    setInputs((prev) => {
      const next = prev.map((row) => [...row]);
      next[r][c] = letter;
      return next;
    });
    setChecked(false);

    if (letter) {
      const nextPos = getNextCrosswordCell(puzzle, r, c);
      if (nextPos) {
        const key = `${nextPos.r},${nextPos.c}`;
        const ref = inputRefs.current[key];
        if (ref) ref.focus();
      }
    }
  };

  const BackLink = () => (
    <Pressable onPress={onBack} style={pressableStyle([styles.backButton, styles.backButtonRow])}>
      <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
      <Text style={styles.backButtonText}>{backLabel}</Text>
    </Pressable>
  );

  if (loading) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <ActivityIndicator color={COLORS.primary} size="large" />
      </LinearGradient>
    );
  }

  if (!puzzle) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <Text style={styles.emptyText}>No crossword available yet.</Text>
      </LinearGradient>
    );
  }

  const { across, down, cellNumbers } = numberCrossword(puzzle);
  const screenWidth = width;
  const cellSize = Math.max(20, Math.min(36, Math.floor((screenWidth - 40) / puzzle.cols)));
  const fontSize = Math.max(11, Math.floor(cellSize * 0.45));
  const numberFontSize = Math.max(7, Math.floor(cellSize * 0.22));

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <BackLink />
      <ScrollView contentContainerStyle={styles.quizContainer}>
        <Text style={styles.homeTitle}>Daily Crossword</Text>

        <View style={[styles.crosswordGrid, SHADOW]}>
          {puzzle.grid.map((row, r) => (
            <View key={r} style={{ flexDirection: 'row' }}>
              {row.map((cell, c) => {
                if (cell === null) {
                  return <View key={c} style={[styles.crosswordBlock, { width: cellSize, height: cellSize }]} />;
                }
                const filled = inputs[r] ? inputs[r][c] : '';
                let cellStyle = styles.crosswordCell;
                if (checked) {
                  cellStyle = filled === cell ? styles.crosswordCellCorrect : styles.crosswordCellWrong;
                }
                const num = cellNumbers[`${r},${c}`];
                return (
                  <View key={c} style={{ width: cellSize, height: cellSize }}>
                    {num && <Text style={[styles.crosswordCellNumber, { fontSize: numberFontSize }]}>{num}</Text>}
                      <TextInput
                      ref={(el) => { inputRefs.current[`${r},${c}`] = el; }}
                      style={[cellStyle, { width: cellSize, height: cellSize, fontSize }]}
                      maxLength={1}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      value={filled}
                      onChangeText={(val) => setCell(r, c, val)}
                    />
                  </View>
                );
              })}
            </View>
          ))}
        </View>

        <Pressable onPress={() => setChecked(true)} style={pressableStyle([styles.nextButton, SHADOW])}>
          <Ionicons name="checkmark-circle-outline" size={18} color={COLORS.primaryText} />
          <Text style={styles.nextButtonText}>Check</Text>
        </Pressable>

        <Text style={[styles.groupSectionLabel, { marginTop: 24 }]}>Across</Text>
        {across.map((w) => (
          <View key={'a' + w.number} style={styles.clueRow}>
            <Text style={styles.clueNumber}>{w.number}.</Text>
            <Text style={styles.clueText}>{w.clue}</Text>
          </View>
        ))}

        <Text style={[styles.groupSectionLabel, { marginTop: 16 }]}>Down</Text>
        {down.map((w) => (
          <View key={'d' + w.number} style={styles.clueRow}>
            <Text style={styles.clueNumber}>{w.number}.</Text>
            <Text style={styles.clueText}>{w.clue}</Text>
          </View>
        ))}
      </ScrollView>
    </LinearGradient>
  );
}


function TruthLieGameScreen({ onBack, backLabel = 'Back' }) {
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState([]);
  const [index, setIndex] = useState(0);
  const [statements, setStatements] = useState([]);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);

  const loadStatements = (card) => {
    setStatements(shuffle([
      { text: card.truth_1, isLie: false },
      { text: card.truth_2, isLie: false },
      { text: card.the_lie, isLie: true },
    ]));
    setSelected(null);
  };

  const startRound = async () => {
    setLoading(true);
    setFinished(false);
    setScore(0);
    setIndex(0);
    const { data, error } = await supabase.from('concepts').select('*').not('truth_1', 'is', null);
    if (!error && data && data.length > 0) {
      const picks = shuffle(data).slice(0, 5);
      setCards(picks);
      loadStatements(picks[0]);
    } else {
      setCards([]);
    }
    setLoading(false);
  };

  useEffect(() => { startRound(); }, []);

  const handleSelect = (s) => {
    if (selected) return;
    setSelected(s);
    if (s.isLie) setScore((sc) => sc + 1);
  };

  const next = () => {
    const isLast = index === cards.length - 1;
    if (isLast) {
      setFinished(true);
    } else {
      const nextIndex = index + 1;
      setIndex(nextIndex);
      loadStatements(cards[nextIndex]);
    }
  };

  const BackLink = () => (
    <Pressable onPress={onBack} style={pressableStyle([styles.backButton, styles.backButtonRow])}>
      <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
      <Text style={styles.backButtonText}>{backLabel}</Text>
    </Pressable>
  );

  if (loading) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <ActivityIndicator color={COLORS.primary} size="large" />
      </LinearGradient>
    );
  }

  if (cards.length === 0) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <Text style={styles.emptyText}>No Truth or Lie cards yet.</Text>
      </LinearGradient>
    );
  }

  if (finished) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <Text style={styles.quizDoneEmoji}>🎭</Text>
        <Text style={styles.resultText}>Round complete</Text>
        <Text style={styles.resultScore}>{score} / {cards.length}</Text>
        <Pressable onPress={startRound} style={pressableStyle([styles.nextButton, SHADOW])}>
          <Text style={styles.nextButtonText}>Play Again</Text>
        </Pressable>
      </LinearGradient>
    );
  }

  const card = cards[index];

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <BackLink />
      <ScrollView contentContainerStyle={styles.quizContainer}>
        <Text style={styles.quizProgress}>Question {index + 1} of {cards.length}</Text>
        <Text style={styles.questionText}>{card.title}</Text>
        <Text style={styles.gameLabel}>Which one is the lie?</Text>
        {statements.map((s, idx) => {
          let optStyle = styles.optionButton;
          if (selected) {
            if (s.isLie) optStyle = styles.optionButtonCorrect;
            else if (s === selected) optStyle = styles.optionButtonWrong;
          }
          return (
            <Pressable key={idx} style={pressableStyle(optStyle)} onPress={() => handleSelect(s)}>
              <Text style={styles.optionText}>{s.text}</Text>
            </Pressable>
          );
        })}
        {selected && (
          <Pressable onPress={next} style={pressableStyle([styles.nextButton, SHADOW])}>
            <Text style={styles.nextButtonText}>{index === cards.length - 1 ? 'Finish' : 'Next'}</Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.primaryText} />
          </Pressable>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

function EmojiRiddleGameScreen({ onBack, backLabel = 'Back' }) {
  const [loading, setLoading] = useState(true);
  const [allCards, setAllCards] = useState([]);
  const [cards, setCards] = useState([]);
  const [index, setIndex] = useState(0);
  const [options, setOptions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);

  const buildOptions = (all, correctCard) => {
    const others = all.filter((c) => c.id !== correctCard.id);
    const distractors = shuffle(others).slice(0, 3).map((c) => c.title);
    return shuffle([correctCard.title, ...distractors]);
  };

  const startRound = async () => {
    setLoading(true);
    setFinished(false);
    setScore(0);
    setIndex(0);
    setSelected(null);
    const { data, error } = await supabase.from('concepts').select('*').not('emoji_riddle', 'is', null);
    if (!error && data && data.length >= 4) {
      setAllCards(data);
      const picks = shuffle(data).slice(0, 5);
      setCards(picks);
      setOptions(buildOptions(data, picks[0]));
    } else {
      setCards([]);
    }
    setLoading(false);
  };

  useEffect(() => { startRound(); }, []);

  const handleSelect = (title) => {
    if (selected) return;
    setSelected(title);
    if (title === cards[index].title) setScore((s) => s + 1);
  };

  const next = () => {
    const isLast = index === cards.length - 1;
    if (isLast) {
      setFinished(true);
    } else {
      const nextIndex = index + 1;
      setIndex(nextIndex);
      setSelected(null);
      setOptions(buildOptions(allCards, cards[nextIndex]));
    }
  };

  const BackLink = () => (
    <Pressable onPress={onBack} style={pressableStyle([styles.backButton, styles.backButtonRow])}>
      <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
      <Text style={styles.backButtonText}>{backLabel}</Text>
    </Pressable>
  );

  if (loading) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <ActivityIndicator color={COLORS.primary} size="large" />
      </LinearGradient>
    );
  }

  if (cards.length === 0) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <Text style={styles.emptyText}>Not enough emoji riddles yet.</Text>
      </LinearGradient>
    );
  }

  if (finished) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={styles.center}>
        <BackLink />
        <Text style={styles.quizDoneEmoji}>{'\u{1F914}'}</Text>
        <Text style={styles.resultText}>Round complete</Text>
        <Text style={styles.resultScore}>{score} / {cards.length}</Text>
        <Pressable onPress={startRound} style={pressableStyle([styles.nextButton, SHADOW])}>
          <Text style={styles.nextButtonText}>Play Again</Text>
        </Pressable>
      </LinearGradient>
    );
  }

  const card = cards[index];

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <BackLink />
      <ScrollView contentContainerStyle={styles.quizContainer}>
        <Text style={styles.quizProgress}>Card {index + 1} of {cards.length}</Text>
        <Text style={styles.emojiDisplayLarge}>{card.emoji_riddle}</Text>
        {options.map((title, idx) => {
          let optStyle = styles.optionButton;
          if (selected) {
            if (title === card.title) optStyle = styles.optionButtonCorrect;
            else if (title === selected) optStyle = styles.optionButtonWrong;
          }
          return (
            <Pressable key={idx} style={pressableStyle(optStyle)} onPress={() => handleSelect(title)}>
              <Text style={styles.optionText}>{title}</Text>
            </Pressable>
          );
        })}
        {selected && (
          <>
            <Text style={styles.emojiRevealHook}>{card.hook}</Text>
            <Pressable onPress={next} style={pressableStyle([styles.nextButton, SHADOW])}>
              <Text style={styles.nextButtonText}>{index === cards.length - 1 ? 'Finish' : 'Next'}</Text>
              <Ionicons name="chevron-forward" size={18} color={COLORS.primaryText} />
            </Pressable>
          </>
        )}
      </ScrollView>
    </LinearGradient>
  );
}



// Shows the tapped card full-screen, and — same vertical-paging FlatList pattern as
// FeedScreen/DailyThreeScreen — lets you keep swiping up/down through the rest of
// conceptIds (the list the card was opened from, in that list's own order), instead of
// stranding you on a single card with no way back to its neighbors without leaving.
// banner: optional { senderName, question, note } — set when the card was opened from the
// "Shared with you" inbox (or, later, a share link).
function CardDetailScreen({ conceptIds, initialId, onBack, backLabel = 'Library', banner = null }) {
  const { userId } = useContext(UserContext);
  const [loading, setLoading] = useState(true);
  const [concepts, setConcepts] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [outerScrollEnabled, setOuterScrollEnabled] = useState(true);
  const [listHeight, setListHeight] = useState(CARD_HEIGHT);
  // The jump to the tapped card (initialScrollIndex) is computed as listHeight * index, so the
  // list must not mount until listHeight is the real measured value — otherwise the offset is
  // calculated from the CARD_HEIGHT guess and lands partway between cards, by more the further
  // down the list the card is.
  const [heightMeasured, setHeightMeasured] = useState(false);
  const listRef = useRef(null);
  const { handleViewableItemsChanged, toggleSave, isSaved, onPageChange } = useCardActivity(userId);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      const { data, error } = await supabase.from('concepts').select('*').in('id', conceptIds);
      if (error) {
        setErrorMsg(JSON.stringify(error, null, 2));
        setLoading(false);
        return;
      }
      // .in() doesn't preserve order, so re-sort to match the order the list was opened in.
      const byId = new Map((data || []).map((c) => [c.id, c]));
      setConcepts(conceptIds.map((id) => byId.get(id)).filter(Boolean));
      setLoading(false);
      await ensureActivityLoaded(userId);
    })();
  }, [conceptIds, userId]);

  const initialIndex = Math.max(0, concepts.findIndex((c) => c.id === initialId));

  // Web only: put the list on the tapped card reliably. Scroll-snap (what pagingEnabled becomes on
  // web) can pull a programmatic jump back to the first cards while the cards are still laying out,
  // so snapping stays off until the jump has stuck, and the jump is re-applied for a moment if the
  // position isn't where it should be. Native keeps pagingEnabled on from the start, unchanged.
  const offsetRef = useRef(0);
  const webPager = useWebPager(listHeight);
  const [snapReady, setSnapReady] = useState(Platform.OS !== 'web');
  const listHeightRef = useRef(listHeight);
  listHeightRef.current = listHeight;
  useEffect(() => {
    if (Platform.OS !== 'web' || !heightMeasured || concepts.length === 0) return undefined;
    webPager.setActive(initialIndex);
    if (initialIndex <= 0) { setSnapReady(true); return undefined; }
    const timers = [0, 60, 150, 300, 600].map((ms) => setTimeout(() => {
      const target = initialIndex * listHeightRef.current;
      if (listRef.current && Math.abs(offsetRef.current - target) > 2) {
        listRef.current.scrollToOffset({ offset: target, animated: false });
      }
    }, ms));
    timers.push(setTimeout(() => setSnapReady(true), 900));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heightMeasured, concepts.length]);

  const header = <ScreenHeader title="" backLabel={backLabel} onBack={onBack} collapsed={false} />;

  if (loading) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} size="large" />
        </View>
      </LinearGradient>
    );
  }

  if (errorMsg || concepts.length === 0) {
    return (
      <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
        {header}
        <View style={styles.center}>
          {errorMsg ? (
            <Text style={{ color: COLORS.error, fontSize: 13, fontFamily: 'monospace' }}>{errorMsg}</Text>
          ) : (
            <Text style={styles.emptyText}>Card not found.</Text>
          )}
        </View>
      </LinearGradient>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {header}
      {banner && <ShareBanner banner={banner} />}
      <View
        style={{ flex: 1 }}
        onLayout={(e) => {
          setListHeight(Math.ceil(e.nativeEvent.layout.height));
          setHeightMeasured(true);
        }}
      >
      {heightMeasured && (

      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        data={concepts}
        keyExtractor={(item) => item.id}
        initialScrollIndex={initialIndex > 0 ? initialIndex : undefined}
        // Web only: render every card up front so the jump to the tapped card lands exactly on it,
        // instead of landing among cards the list has not created yet.
        {...(Platform.OS === 'web' ? { initialNumToRender: concepts.length, maxToRenderPerBatch: concepts.length, windowSize: concepts.length * 2 + 1, removeClippedSubviews: false } : {})}
        getItemLayout={(data, i) => ({ length: listHeight, offset: listHeight * i, index: i })}
        onScrollToIndexFailed={({ index }) => {
          setTimeout(() => listRef.current?.scrollToIndex({ index, animated: false }), 50);
        }}
        scrollEnabled={outerScrollEnabled}
        pagingEnabled
        bounces={false}
        showsVerticalScrollIndicator={false}
        snapToInterval={listHeight}
        decelerationRate="fast"
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
        {...webPagerListProps(snapReady)}
        {...(Platform.OS === 'web' ? {
          onScroll: (e) => { offsetRef.current = e.nativeEvent.contentOffset.y; webPager.onScroll(e); },
          scrollEventThrottle: 16,
          extraData: webPager.activeIndex,
        } : {})}
        renderItem={({ item, index }) => webSnapItem(
          Platform.OS === 'web' && Math.abs(index - webPager.activeIndex) > 2 ? (
            <View style={{ height: listHeight }} />
          ) : (
            <ConceptCard
              concept={item}
              saved={isSaved(item.id)}
              onToggleSave={() => toggleSave(item)}
              onPageScrollChange={setOuterScrollEnabled}
              onPageChange={onPageChange}
              cardHeight={listHeight}
            />
          )
        )}
      />
      )}
      </View>
    </View>
  );
}

// card_activity has a (user_id, concept_id) primary key, so — unlike the old device-based
// user_interactions table — there's exactly one row per saved card; no de-dup needed here.
async function fetchSavedConceptIds(userId) {
  if (!userId) return { ids: [] };
  const { data, error } = await supabase
    .from('card_activity')
    .select('concept_id')
    .eq('user_id', userId)
    .eq('saved', true);
  if (error) return { error };
  return { ids: (data || []).map((r) => r.concept_id) };
}

// Fetches the saved concept ids for this user from card_activity (the same table the star
// toggle already writes to — no second storage mechanism), then loads the full concept rows.
async function fetchSavedConcepts(userId) {
  if (!userId) return { concepts: [] };
  // card_activity.saved_at is a real timestamp now (unlike the old user_interactions table),
  // so most-recently-saved-first is exact, not a created_at stand-in.
  const { data, error } = await supabase
    .from('card_activity')
    .select('concept_id, saved_at')
    .eq('user_id', userId)
    .eq('saved', true)
    .order('saved_at', { ascending: false });
  if (error) return { error };
  const ids = (data || []).map((r) => r.concept_id);
  if (ids.length === 0) return { concepts: [] };

  const { data: concepts, error: cError } = await supabase.from('concepts').select('*').in('id', ids);
  if (cError) return { error: cError };
  const byId = new Map((concepts || []).map((c) => [c.id, c]));
  return { concepts: ids.map((id) => byId.get(id)).filter(Boolean) };
}


// A card can now have several notes, but My Notes shows one row per card (per the redesign):
// each returned item is that card's most-recently-updated note (for the preview/date) plus a
// count of how many notes that card has in total.
async function fetchMyNotes(userId) {
  if (!userId) return { notes: [] };
  const { data, error } = await supabase
    .from('notes')
    .select('id, concept_id, body, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) return { error };
  const byConceptId = new Map(); // concept_id -> { note, count }
  (data || []).forEach((row) => {
    const existing = byConceptId.get(row.concept_id);
    if (!existing) byConceptId.set(row.concept_id, { note: row, count: 1 }); // first seen = most recent (desc order)
    else existing.count += 1;
  });
  const ids = Array.from(byConceptId.keys());
  if (ids.length === 0) return { notes: [] };
  const { data: concepts, error: cError } = await supabase.from('concepts').select('*').in('id', ids);
  if (cError) return { error: cError };
  const conceptById = new Map((concepts || []).map((c) => [c.id, c]));
  const notes = ids
    .map((id) => {
      const { note, count } = byConceptId.get(id);
      return { concept_id: id, concept: conceptById.get(id), note_id: note.id, body: note.body, updated_at: note.updated_at, count };
    })
    .filter((n) => n.concept)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return { notes };
}

// Shared by MyNotesScreen and ConversationsScreen: swipe a row left to delete it, with a 4s
// "Undo" window before the delete actually reaches Supabase.
function useUndoableDelete() {
  const [pendingDelete, setPendingDelete] = useState(null); // { item, timeoutId }
  const beginDelete = useCallback((item, commitFn) => {
    const timeoutId = setTimeout(async () => {
      await commitFn(item);
      setPendingDelete(null);
    }, 4000);
    setPendingDelete({ item, timeoutId });
  }, []);
  const undo = useCallback((onUndone) => {
    setPendingDelete((prev) => {
      if (prev) {
        clearTimeout(prev.timeoutId);
        onUndone && onUndone();
      }
      return null;
    });
  }, []);
  useEffect(() => () => {
    if (pendingDelete) clearTimeout(pendingDelete.timeoutId);
  }, [pendingDelete]);
  return { pendingDelete, beginDelete, undo };
}

function UndoToast({ visible, label, onUndo }) {
  if (!visible) return null;
  return (
    <View style={styles.undoToast}>
      <Text style={styles.undoToastText}>{label}</Text>
      <Pressable onPress={onUndo} hitSlop={8}>
        <Text style={styles.undoToastAction}>Undo</Text>
      </Pressable>
    </View>
  );
}


const CONVERSATION_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'debate', label: 'Debates' },
  { key: 'deeper', label: 'Go deeper' },
  { key: 'simple', label: 'Explain simply' },
  { key: 'explain', label: 'Explain it back' },
  { key: 'prepare', label: 'Prepared' },
];

// filterConceptId: when set (arrived via a card's "See all"), scopes the list to that one
// card's conversations — everything else about the screen (search, mode filter, grouping,
// swipe-to-delete) works the same either way.

// ---- Sharing: profiles, shares, blocks (see sharing.sql) ----
// A share is either 'external' (an image + caption sent through the OS share sheet) or 'in_app'
// (addressed to another user's handle and shown in their "Shared with you" inbox). Every write
// here is wrapped so a failure produces a friendly message, never a raw error.
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const SHARE_NOTE_MAX = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(cond, timeoutMs, stepMs = 50) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(stepMs);
  }
  return true;
}

function normalizeHandle(raw) {
  return (raw || '').trim().replace(/^@+/, '').toLowerCase();
}

// The signed-in user's own profile, cached per user (cleared by clearUserCaches). Only a found
// profile is cached; "no profile yet" is re-checked each time since it's a single cheap query.
let myProfileUserId = null;
let myProfile = null;

async function fetchMyProfile(userId) {
  if (!userId) return { profile: null };
  if (myProfileUserId === userId && myProfile) return { profile: myProfile };
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, handle, display_name')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) { console.error('Failed to load profile', error); return { error }; }
  if (data) { myProfileUserId = userId; myProfile = data; }
  return { profile: data || null };
}

// existing: true -> update the current row, false -> create it.
async function saveMyProfile(userId, handle, displayName, existing) {
  const fields = { handle, display_name: displayName };
  const query = existing
    ? supabase.from('profiles').update(fields).eq('user_id', userId)
    : supabase.from('profiles').insert({ user_id: userId, ...fields });
  const { data, error } = await query.select('user_id, handle, display_name').single();
  if (error) {
    console.error('Failed to save profile', error);
    if (error.code === '23505') return { message: 'That handle is already taken. Try another.' };
    if (error.code === '23514') return { message: 'Handles are 3–20 characters: lowercase letters, numbers and underscores.' };
    if (error.code === '42P01' || error.code === 'PGRST205') return { message: "Profiles aren't set up yet." };
    return { message: "Couldn't save your profile. Please try again." };
  }
  myProfileUserId = userId;
  myProfile = data;
  return { profile: data };
}

async function lookupProfileByHandle(handle) {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, handle, display_name')
    .eq('handle', handle)
    .maybeSingle();
  if (error) { console.error('Handle lookup failed', error); return { error }; }
  return { profile: data || null };
}

// Up to 5 distinct people this user has most recently sent something to in the app.
async function fetchRecentRecipients(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('shares')
    .select('recipient_id, created_at')
    .eq('sender_id', userId)
    .eq('channel', 'in_app')
    .not('recipient_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(40);
  if (error || !data) return [];
  const ids = [];
  data.forEach((r) => { if (!ids.includes(r.recipient_id)) ids.push(r.recipient_id); });
  const top = ids.slice(0, 5);
  if (top.length === 0) return [];
  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('user_id, handle, display_name')
    .in('user_id', top);
  if (pErr || !profiles) return [];
  const byId = new Map(profiles.map((p) => [p.user_id, p]));
  return top.map((id) => byId.get(id)).filter(Boolean);
}

// Creates the shares row (the database fills in sender_id and the 8-character code). Retries on
// the vanishingly unlikely code collision.
async function createShareRow({ conceptId, question, note, channel, recipientId }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('shares')
      .insert({
        concept_id: conceptId,
        question: question || null,
        note: (note || '').trim() || null,
        channel,
        recipient_id: recipientId || null,
      })
      .select('id, code')
      .single();
    if (!error) return { share: data };
    if (error.code !== '23505') { console.error('Failed to create share', error); return { error }; }
  }
  return { error: { message: 'code collision' } };
}

function shareCaption({ title, question, note, code }) {
  let text = question ? `${title}: ${question}` : title;
  if (note && note.trim()) text += `\n\n${note.trim()}`;
  if (SHARE_LINKS_ENABLED && code) text += `\n\n${SHARE_BASE_URL}/s/${code}`;
  return text;
}

function shareLinkHost() {
  return SHARE_BASE_URL.replace(/^https?:\/\//, '');
}

async function fetchInbox(userId) {
  if (!userId) return { items: [] };
  // Shares from senders this user has blocked are filtered out by the database itself (the
  // "recipients read shares addressed to them" policy), so they never come back here.
  const { data, error } = await supabase
    .from('shares')
    .select('id, code, sender_id, concept_id, question, note, created_at, opened_at')
    .eq('recipient_id', userId)
    .is('recipient_hidden_at', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return { error };
  const rows = data || [];
  if (rows.length === 0) return { items: [] };
  const senderIds = Array.from(new Set(rows.map((r) => r.sender_id)));
  const conceptIds = Array.from(new Set(rows.map((r) => r.concept_id)));
  const [{ data: profiles }, { data: concepts, error: cError }] = await Promise.all([
    supabase.from('profiles').select('user_id, handle, display_name').in('user_id', senderIds),
    supabase.from('concepts').select('id, title, category').in('id', conceptIds),
  ]);
  if (cError) return { error: cError };
  const profileById = new Map((profiles || []).map((p) => [p.user_id, p]));
  const conceptById = new Map((concepts || []).map((c) => [c.id, c]));
  const items = rows
    .map((r) => {
      const p = profileById.get(r.sender_id);
      return {
        ...r,
        concept: conceptById.get(r.concept_id),
        senderName: r.sender_id === userId ? 'You' : (p && p.display_name) || 'Someone',
      };
    })
    .filter((r) => r.concept);
  return { items };
}

async function fetchUnreadShareCount(userId) {
  if (!userId) return 0;
  const { count, error } = await supabase
    .from('shares')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', userId)
    .is('opened_at', null)
    .is('recipient_hidden_at', null);
  return error ? null : count || 0;
}

async function markShareOpened(shareId) {
  try {
    await supabase.from('shares').update({ opened_at: new Date().toISOString() }).eq('id', shareId).is('opened_at', null);
  } catch (e) {
    console.error('Failed to mark share opened', e);
  }
}

async function hideShareFromInbox(shareId) {
  const { error } = await supabase.from('shares').update({ recipient_hidden_at: new Date().toISOString() }).eq('id', shareId);
  if (error) console.error('Failed to hide share', error);
  return { ok: !error };
}

async function blockUser(userId, blockedId) {
  const { error } = await supabase.from('blocks').insert({ blocker_id: userId, blocked_id: blockedId });
  // 23505 = already blocked, which is the outcome we wanted anyway.
  if (error && error.code !== '23505') { console.error('Failed to block', error); return { ok: false }; }
  return { ok: true };
}

// Refetch when the app comes back to the foreground (the app's screens already refetch on mount).
function useRefreshOnForeground(fn) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') fnRef.current(); });
    return () => sub.remove();
  }, []);
}

// ---- Share image (1080x1350) ----
// Text steps down through `sizes` until it fits `maxHeight`; at the smallest size it falls back
// to an ellipsis rather than overflowing. Remounted (key) whenever its text changes. Reports
// "settled" into readyRef so the capture code can wait for the final layout.
function FitText({ text, sizes, lineRatio, maxHeight, style, name, readyRef, maxLinesCap }) {
  const [idx, setIdx] = useState(() => {
    if (readyRef) readyRef.current[name] = false;
    return 0;
  });
  const size = sizes[idx];
  const lineHeight = Math.round(size * lineRatio);
  const isLast = idx >= sizes.length - 1;
  const maxLines = Math.max(1, Math.min(maxLinesCap || Infinity, Math.floor(maxHeight / lineHeight)));
  return (
    <Text
      style={[style, { fontSize: size, lineHeight }]}
      numberOfLines={isLast ? maxLines : undefined}
      ellipsizeMode="tail"
      onTextLayout={(e) => {
        const lines = e.nativeEvent.lines.length;
        if (!isLast && (lines * lineHeight > maxHeight || lines > (maxLinesCap || Infinity))) setIdx((i) => i + 1);
        else if (readyRef) readyRef.current[name] = true;
      }}
    >
      {text}
    </Text>
  );
}

const SHARE_IMAGE_W = 1080;
const SHARE_IMAGE_H = 1350;

// linkText: the short link shown in the footer, or null for none.
function ShareCardView({ concept, question, note, linkText, readyRef }) {
  const catColor = CATEGORY_COLORS[concept.category] || COLORS.textTertiary;
  const hasNote = !!note && !!note.trim();
  const [noteRegionH, setNoteRegionH] = useState(null);
  // Until the note's region has been measured the note isn't drawn, so it isn't "settled" yet.
  if (readyRef && hasNote && noteRegionH == null) readyRef.current.note = false;
  return (
    <View style={styles.shareImage}>
      <View style={styles.shareImageCategoryRow}>
        <View style={[styles.shareImageDot, { backgroundColor: catColor }]} />
        <Text style={[styles.shareImageCategory, { color: catColor }]} numberOfLines={1}>
          {CATEGORY_LABELS[concept.category] ?? concept.category}
        </Text>
      </View>

      <FitText
        key={`t-${concept.title}`}
        name="title"
        readyRef={readyRef}
        text={concept.title}
        sizes={[84, 76, 68, 60, 54, 48, 44]}
        lineRatio={1.2}
        maxHeight={200}
        style={styles.shareImageTitle}
      />
      <FitText
        key={`h-${concept.hook}`}
        name="hook"
        readyRef={readyRef}
        text={concept.hook || ''}
        sizes={[40, 36, 33, 30, 28, 26]}
        lineRatio={1.4}
        maxHeight={220}
        style={styles.shareImageHook}
      />

      {/* Order: hook, then the question (if one was chosen), then the note. */}
      {!!question && (
        <View style={{ marginTop: 40 }}>
          <View style={styles.shareImageDivider} />
          <Text style={styles.shareImageLabel}>WORTH DISCUSSING</Text>
          <FitText
            key={`q-${question}`}
            name="question"
            readyRef={readyRef}
            text={question}
            sizes={[40, 36, 33, 30, 28, 26]}
            lineRatio={1.4}
            maxHeight={224}
            style={styles.shareImageQuestion}
          />
        </View>
      )}

      {/* The note gets ALL the space left below whatever precedes it (the hook, or the question):
          this region flexes to fill it, is measured, and the note steps its font size down until
          it fits that height AND is at most 8 lines (ending in an ellipsis only if it still
          can't at the smallest size). */}
      {hasNote ? (
        <View style={styles.shareImageNoteRegion} onLayout={(e) => setNoteRegionH(Math.floor(e.nativeEvent.layout.height))}>
          {noteRegionH != null && (
            <View style={styles.shareImageNoteWrap}>
              <FitText
                key={`n-${note.trim()}-${noteRegionH}`}
                name="note"
                readyRef={readyRef}
                text={note.trim()}
                sizes={[34, 32, 30, 28, 26, 24, 22, 20]}
                lineRatio={1.4}
                maxHeight={noteRegionH}
                maxLinesCap={8}
                style={styles.shareImageNote}
              />
            </View>
          )}
        </View>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      <View style={styles.shareImageFooter}>
        <Image
          source={require('./assets/kepos-gate-mark.png')}
          style={styles.shareImageLogo}
          resizeMode="contain"
          onLoad={() => { if (readyRef) readyRef.current.logo = true; }}
          onError={() => { if (readyRef) readyRef.current.logo = true; }}
        />
        <View style={{ flex: 1 }}>
          <Wordmark size={44} lineHeight={54} suffixStyle={styles.shareImageWordmarkSuffix} readyRef={readyRef} />
          <Text style={styles.shareImageTagline} numberOfLines={1}>{APP_TAGLINE}</Text>
        </View>
        {!!linkText && <Text style={styles.shareImageLink} numberOfLines={1}>{linkText}</Text>}
      </View>
    </View>
  );
}

// ---- Handle + display name form (share sheet first-use, and the Account screen) ----
function ProfileForm({ userId, initial, submitLabel, onSaved }) {
  const [handle, setHandle] = useState(initial ? initial.handle : '');
  const [displayName, setDisplayName] = useState(initial ? initial.display_name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const submit = async () => {
    if (busy) return;
    const h = normalizeHandle(handle);
    const name = displayName.trim();
    if (!HANDLE_RE.test(h)) {
      setError('Handles are 3–20 characters: lowercase letters, numbers and underscores.');
      return;
    }
    if (name.length < 1 || name.length > 40) {
      setError('Enter a display name (up to 40 characters).');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await saveMyProfile(userId, h, name, !!initial);
    setBusy(false);
    if (result.message) { setError(result.message); return; }
    setSaved(true);
    onSaved && onSaved(result.profile);
  };

  return (
    <View>
      <Text style={styles.noteStartWithLabel}>HANDLE</Text>
      <View style={styles.shareHandleField}>
        <Text style={styles.shareHandleAt}>@</Text>
        <TextInput
          style={styles.shareHandleInput}
          value={handle}
          onChangeText={(t) => { setHandle(t.replace(/\s/g, '').replace(/^@+/, '').toLowerCase()); setError(null); setSaved(false); }}
          placeholder="your_handle"
          placeholderTextColor={COLORS.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={20}
          editable={!busy}
        />
      </View>
      <Text style={styles.noteStartWithLabel}>DISPLAY NAME</Text>
      <TextInput
        style={styles.secureInput}
        value={displayName}
        onChangeText={(t) => { setDisplayName(t); setError(null); setSaved(false); }}
        placeholder="Your name"
        placeholderTextColor={COLORS.textMuted}
        autoCorrect={false}
        maxLength={40}
        editable={!busy}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      {error && <Text style={styles.secureError}>{error}</Text>}
      {saved && !error && <Text style={styles.shareStatusText}>Saved.</Text>}
      <Pressable style={pressableStyle([styles.primaryButton, busy && { opacity: 0.5 }])} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color={COLORS.primaryText} /> : <Text style={styles.primaryButtonText}>{submitLabel}</Text>}
      </Pressable>
    </View>
  );
}

// ---- The "Share this idea" sheet ----
const SHARE_FONTS = ['Cinzel_700Bold', 'Cinzel_600SemiBold', 'Inter_400Regular', 'Inter_600SemiBold'];

function ShareSheet({ visible, concept, onClose }) {
  const { userId } = useContext(UserContext);
  const questions = useMemo(
    () => [concept.discussion_question, concept.discussion_question_2, concept.discussion_question_3].filter(Boolean),
    [concept]
  );
  const [stage, setStage] = useState('compose'); // compose | profile | recipient | sent
  // null = no question selected (tap the selected row again to clear it).
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [note, setNote] = useState('');
  const [noteFocused, setNoteFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [linkCode, setLinkCode] = useState(null);
  const [toText, setToText] = useState('');
  const [match, setMatch] = useState(null);
  const [recents, setRecents] = useState([]);
  const [sentTo, setSentTo] = useState(null);
  const captureViewRef = useRef(null);
  const captureReadyRef = useRef({});
  const previewReadyRef = useRef({});

  const question = (selectedIdx != null && questions[selectedIdx]) || '';
  const previewWidth = Math.min(width - SPACING.lg * 2 - 2, 300);
  const previewScale = previewWidth / SHARE_IMAGE_W;
  const previewHeight = previewScale * SHARE_IMAGE_H;
  const previewLink = SHARE_LINKS_ENABLED ? `${shareLinkHost()}/s/xxxxxxxx` : null;
  const captureLink = SHARE_LINKS_ENABLED && linkCode ? `${shareLinkHost()}/s/${linkCode}` : null;

  useEffect(() => {
    if (!visible) {
      // The image views unmount with the Modal, so forget their old "settled" flags.
      captureReadyRef.current = {};
      previewReadyRef.current = {};
      return;
    }
    setStage('compose');
    setSelectedIdx(0);
    setNote('');
    setBusy(false);
    setStatus(null);
    setLinkCode(null);
    setToText('');
    setMatch(null);
    setSentTo(null);
  }, [visible]);

  // "To" lookup, debounced; only runs once the text is a valid handle.
  useEffect(() => {
    if (stage !== 'recipient') return undefined;
    const h = normalizeHandle(toText);
    if (!h) { setMatch(null); return undefined; }
    if (!HANDLE_RE.test(h)) { setMatch({ state: 'invalid' }); return undefined; }
    setMatch({ state: 'loading' });
    let cancelled = false;
    const t = setTimeout(async () => {
      const result = await lookupProfileByHandle(h);
      if (cancelled) return;
      if (result.error) setMatch({ state: 'error' });
      else if (result.profile) setMatch({ state: 'found', profile: result.profile });
      else setMatch({ state: 'none' });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [toText, stage]);

  const shareImageReady = () => {
    const flags = Object.values(captureReadyRef.current);
    return flags.length > 0 && flags.every(Boolean);
  };

  // Renders the off-screen 1080x1350 view to a PNG and opens the OS share sheet with it.
  // Throws on any problem; the caller falls back to text-only sharing.
  const shareImage = async (caption) => {
    if (!(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
    const fontsOk = await waitUntil(() => SHARE_FONTS.every((f) => Font.isLoaded(f)), 3000);
    if (!fontsOk) throw new Error('fonts not loaded');
    await sleep(150); // let the off-screen view re-render with the link code, if any
    await waitUntil(shareImageReady, 3000);
    const uri = await captureRef(captureViewRef, {
      format: 'png',
      quality: 1,
      result: 'tmpfile',
      width: SHARE_IMAGE_W,
      height: SHARE_IMAGE_H,
    });
    // The OS image share sheet can't carry text, so the caption goes on the clipboard.
    let copied = false;
    try { await Clipboard.setStringAsync(caption); copied = true; } catch (e) { /* non-fatal */ }
    await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: concept.title });
    return copied;
  };

  const shareElsewhere = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    let code = null;
    try {
      const result = await createShareRow({ conceptId: concept.id, question, note, channel: 'external' });
      if (result.share) code = result.share.code;
    } catch (e) { /* sharing still works without a stored row */ }
    setLinkCode(code);
    const caption = shareCaption({ title: concept.title, question, note, code });

    // Web: no image capture or native share sheet. Use the browser's share dialog (text) where it
    // exists, otherwise copy the caption so it can be pasted anywhere.
    if (Platform.OS === 'web') {
      let webDone = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title: concept.title, text: caption });
          webDone = true;
        } else {
          await Clipboard.setStringAsync(caption);
          setStatus('Copied — paste it into a message.');
          webDone = true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') {
          // The person closed the share dialog: nothing was shared.
        } else {
          try {
            await Clipboard.setStringAsync(caption);
            setStatus('Copied — paste it into a message.');
            webDone = true;
          } catch (e2) {
            setStatus("Couldn't open sharing right now. Please try again.");
          }
        }
      }
      if (webDone) recordShared(userId, concept.id);
      setBusy(false);
      return;
    }

    let done = false;
    try {
      const copied = await shareImage(caption);
      done = true;
      setStatus(copied ? 'Caption copied — paste it with the image if you like.' : null);
    } catch (e) {
      console.error('Image share failed, falling back to text', e);
      try {
        const result = await Share.share({ message: caption });
        done = result.action !== Share.dismissedAction;
      } catch (e2) {
        setStatus("Couldn't open sharing right now. Please try again.");
      }
    }
    if (done) recordShared(userId, concept.id);
    setBusy(false);
  };

  const loadRecents = async () => {
    setRecents(await fetchRecentRecipients(userId));
  };

  const startSend = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    const { profile, error } = await fetchMyProfile(userId);
    setBusy(false);
    if (error) { setStatus(`Sending in ${APP_NAME} isn't available right now.`); return; }
    setStage(profile ? 'recipient' : 'profile');
    if (profile) loadRecents();
  };

  const sendInApp = async () => {
    if (busy || !match || match.state !== 'found') return;
    setBusy(true);
    setStatus(null);
    const recipient = match.profile;
    const result = await createShareRow({
      conceptId: concept.id, question, note, channel: 'in_app', recipientId: recipient.user_id,
    });
    setBusy(false);
    if (result.error) { setStatus("Couldn't send that. Please try again."); return; }
    recordShared(userId, concept.id);
    setSentTo(recipient);
    setStage('sent');
    setTimeout(onClose, 1400);
  };

  const backToCompose = () => { setStage('compose'); setStatus(null); };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.noteSheet, SHADOW, { maxHeight: height * 0.9 }]}>
          <View style={styles.noteSheetHandle} />

          {stage === 'compose' && (
            <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false}>
              <Text style={styles.noteSheetTitle}>Share this idea</Text>

              {questions.length > 0 && (
                <View>
                  <Text style={[styles.noteStartWithLabel, { marginTop: SPACING.sm }]}>PICK A QUESTION (OPTIONAL)</Text>
                  {questions.map((q, i) => (
                    <Pressable
                      key={i}
                      onPress={() => setSelectedIdx((cur) => (cur === i ? null : i))}
                      style={pressableStyle([styles.shareQuestionRow, i === selectedIdx && styles.shareQuestionRowSelected])}
                    >
                      <Text style={styles.shareQuestionText}>{q}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              <Text style={[styles.noteStartWithLabel, { marginTop: SPACING.sm }]}>ADD A NOTE (OPTIONAL)</Text>
              {/* Multiline, grows with the text up to ~4 lines and then scrolls inside itself, like
                  Messages. Return inserts a line break; "Done" (shown while editing) dismisses
                  the keyboard, as does dragging the sheet. */}
              <TextInput
                style={[styles.secureInput, styles.shareNoteInput, { marginBottom: SPACING.xs }]}
                value={note}
                onChangeText={setNote}
                onFocus={() => setNoteFocused(true)}
                onBlur={() => setNoteFocused(false)}
                placeholder="Say something about it…"
                placeholderTextColor={COLORS.textMuted}
                maxLength={SHARE_NOTE_MAX}
                multiline
                textAlignVertical="top"
                scrollEnabled
              />
              <View style={styles.shareNoteMetaRow}>
                <Text style={[styles.shareNoteCounter, note.length >= SHARE_NOTE_MAX - 10 && { color: COLORS.danger }]}>
                  {note.length >= SHARE_NOTE_MAX - 80 ? `${note.length}/${SHARE_NOTE_MAX}` : ''}
                </Text>
                {noteFocused && (
                  <Pressable onPress={Keyboard.dismiss} hitSlop={8} style={pressableStyle(styles.shareNoteDone)}>
                    <Text style={styles.secureLinkText}>Done</Text>
                  </Pressable>
                )}
              </View>

              <Text style={styles.noteStartWithLabel}>PREVIEW</Text>
              <View style={[styles.sharePreviewFrame, { width: previewWidth + 2, height: previewHeight + 2 }]}>
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: -(SHARE_IMAGE_W - previewWidth) / 2,
                    top: -(SHARE_IMAGE_H - previewHeight) / 2,
                    width: SHARE_IMAGE_W,
                    height: SHARE_IMAGE_H,
                    transform: [{ scale: previewScale }],
                  }}
                >
                  <ShareCardView concept={concept} question={question} note={note} linkText={previewLink} readyRef={previewReadyRef} />
                </View>
              </View>

              <Pressable
                style={pressableStyle([styles.primaryButton, busy && { opacity: 0.5 }])}
                onPress={shareElsewhere}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={COLORS.primaryText} /> : <Text style={styles.primaryButtonText}>Share elsewhere</Text>}
              </Pressable>
              <Pressable style={pressableStyle([styles.askSecondaryButton, busy && { opacity: 0.5 }])} onPress={startSend} disabled={busy}>
                <Text style={styles.askSecondaryButtonText}>Send in {APP_NAME}</Text>
              </Pressable>
              {!!status && <Text style={styles.shareStatusText}>{status}</Text>}
            </ScrollView>
          )}

          {stage === 'profile' && (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.noteSheetTitle}>Choose your handle</Text>
              <Text style={[styles.secureHelp, { marginTop: SPACING.xs }]}>
                Friends use your handle to send you cards. You can change it later in Account.
              </Text>
              <ProfileForm
                userId={userId}
                initial={null}
                submitLabel="Continue"
                onSaved={() => { setStage('recipient'); loadRecents(); }}
              />
              <Pressable onPress={backToCompose} style={pressableStyle(styles.secureLink)}>
                <Text style={[styles.secureLinkText, { color: COLORS.textTertiary }]}>Back</Text>
              </Pressable>
            </ScrollView>
          )}

          {stage === 'recipient' && (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.noteSheetTitle}>Send in {APP_NAME}</Text>

              <Text style={[styles.noteStartWithLabel, { marginTop: SPACING.sm }]}>TO</Text>
              <View style={styles.shareHandleField}>
                <Text style={styles.shareHandleAt}>@</Text>
                <TextInput
                  style={styles.shareHandleInput}
                  value={toText}
                  onChangeText={(t) => setToText(t.replace(/\s/g, ''))}
                  placeholder="their_handle"
                  placeholderTextColor={COLORS.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  maxLength={21}
                />
              </View>

              {match && match.state === 'loading' && <ActivityIndicator color={COLORS.primary} style={{ marginBottom: SPACING.md }} />}
              {match && match.state === 'found' && (
                <View style={styles.shareMatchCard}>
                  <Ionicons name="person-circle-outline" size={32} color={COLORS.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.askModeTitle} numberOfLines={1}>
                      {match.profile.display_name}{match.profile.user_id === userId ? ' (you)' : ''}
                    </Text>
                    <Text style={styles.askModeDesc} numberOfLines={1}>@{match.profile.handle}</Text>
                  </View>
                  <Ionicons name="checkmark-circle" size={22} color={COLORS.primary} />
                </View>
              )}
              {match && match.state === 'none' && <Text style={styles.secureError}>No one has that handle.</Text>}
              {match && match.state === 'invalid' && (
                <Text style={styles.shareStatusText}>Handles are 3–20 letters, numbers or underscores.</Text>
              )}
              {match && match.state === 'error' && <Text style={styles.secureError}>Couldn't look that up. Try again.</Text>}

              {recents.length > 0 && (
                <View style={{ marginBottom: SPACING.md }}>
                  <Text style={styles.noteStartWithLabel}>RECENT</Text>
                  <View style={styles.notePillRow}>
                    {recents.map((p) => (
                      <Pressable key={p.user_id} onPress={() => setToText(p.handle)} style={pressableStyle([styles.notePill, styles.shareRecentPill])}>
                        <Text style={styles.notePillText} numberOfLines={1}>{p.display_name}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

              {!!status && <Text style={styles.secureError}>{status}</Text>}

              <Pressable
                style={pressableStyle([styles.primaryButton, (busy || !match || match.state !== 'found') && { opacity: 0.5 }])}
                onPress={sendInApp}
                disabled={busy || !match || match.state !== 'found'}
              >
                {busy ? <ActivityIndicator color={COLORS.primaryText} /> : <Text style={styles.primaryButtonText}>Send</Text>}
              </Pressable>
              <Pressable onPress={backToCompose} style={pressableStyle(styles.secureLink)}>
                <Text style={[styles.secureLinkText, { color: COLORS.textTertiary }]}>Back</Text>
              </Pressable>
            </ScrollView>
          )}

          {stage === 'sent' && (
            <View style={{ alignItems: 'center', paddingVertical: SPACING.xl }}>
              <Ionicons name="checkmark-circle-outline" size={56} color={COLORS.primary} />
              <Text style={[styles.noteSheetTitle, { marginTop: SPACING.sm }]}>Sent</Text>
              {!!sentTo && <Text style={styles.askModeDesc}>to @{sentTo.handle}</Text>}
            </View>
          )}
        </View>

        {/* Off-screen, full-size copy that is actually captured. Mounted only while the sheet is. */}
        <View pointerEvents="none" style={styles.shareCaptureHost}>
          <View ref={captureViewRef} collapsable={false}>
            <ShareCardView concept={concept} question={question} note={note} linkText={captureLink} readyRef={captureReadyRef} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---- Shared-with-you banner (shown above a card opened from the inbox or a link) ----
function ShareBanner({ banner }) {
  return (
    <View style={styles.shareBanner}>
      <Text style={styles.shareBannerText} numberOfLines={3}>
        <Text style={styles.shareBannerName}>{banner.senderName}</Text>
        {banner.question ? ` asked: ${banner.question}` : ' shared this with you'}
      </Text>
      {!!banner.note && <Text style={styles.shareBannerNote} numberOfLines={10}>“{banner.note}”</Text>}
    </View>
  );
}

// ---- Inbox: "Shared with you" ----

// ---- Secure your account / sign in / account ----
// Attaching an email to the anonymous user (updateUser) keeps the same user id, so no data
// moves. Signing in on a new device swaps to the secured account's id; App() then clears every
// cache and remounts screens (see applySession).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Maps a Supabase auth error to { kind, message } — kind lets the screen react (e.g. offer
// "Sign in to that account instead" for 'exists').
function describeAuthError(error) {
  const msg = ((error && error.message) || '').toLowerCase();
  const code = (error && error.code) || '';
  const status = error && error.status;
  if (code === 'email_address_invalid' || code === 'validation_failed' || msg.includes('invalid format') || msg.includes('unable to validate email')) {
    return { kind: 'email', message: "That email address doesn't look right. Check it and try again." };
  }
  if (status === 429 || code.includes('rate_limit') || msg.includes('rate limit') || msg.includes('security purposes')) {
    return { kind: 'rate', message: 'Too many attempts. Please wait a minute before trying again.' };
  }
  if (code === 'email_exists' || code === 'identity_already_exists' || msg.includes('already been registered') || msg.includes('already registered')) {
    return { kind: 'exists', message: `That email already belongs to another ${APP_NAME} account.` };
  }
  if (code === 'otp_disabled' || code === 'user_not_found' || msg.includes('signups not allowed') || msg.includes('user not found')) {
    return { kind: 'notfound', message: "We couldn't find a secured account with that email." };
  }
  if (code === 'otp_expired' || msg.includes('expired') || msg.includes('invalid')) {
    return { kind: 'badcode', message: 'That code is wrong or has expired. Check it, or tap Resend code for a new one.' };
  }
  if (status >= 500 || msg.includes('sending') || msg.includes('smtp')) {
    return { kind: 'send', message: "We couldn't send the email right now. Please try again in a few minutes." };
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return { kind: 'network', message: `Couldn't reach ${APP_NAME}. Check your connection and try again.` };
  }
  console.error('Unmapped auth error', error);
  const detail = error ? [error.status, error.code, error.message].filter(Boolean).join(' · ') : '';
  return { kind: 'other', message: `Something went wrong. Please try again.${detail ? `\n(${detail})` : ''}` };
}

// Does the current (anonymous) user have anything that signing in elsewhere would orphan?
// Any failed check counts as "yes" so we err on the side of warning.
async function userHasData(userId) {
  if (!userId) return false;
  try {
    const [notes, convos, saved] = await Promise.all([
      supabase.from('notes').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('ai_conversations').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('card_activity').select('concept_id', { count: 'exact', head: true }).eq('user_id', userId).eq('saved', true),
    ]);
    if (notes.error || convos.error || saved.error) return true;
    return (notes.count || 0) + (convos.count || 0) + (saved.count || 0) > 0;
  } catch (e) {
    return true;
  }
}

const RESEND_SECONDS = 60;

// mode 'secure': attach an email to this anonymous user. mode 'signin': sign in to an
// already-secured account. Both are email step -> code step.
function SecureAccountScreen({ onBack, onDone }) {
  const { userId } = useContext(UserContext);
  const [mode, setMode] = useState('secure');
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const run = async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const address = email.trim().toLowerCase();

  // targetMode lets "Sign in to that account instead" send a sign-in code in the same tap.
  const sendCode = (targetMode = mode, isResend = false) => run(async () => {
    if (!EMAIL_RE.test(address)) {
      setError({ kind: 'email', message: 'Enter a valid email address.' });
      return;
    }
    let result;
    if (targetMode === 'signin') {
      result = await supabase.auth.signInWithOtp({ email: address, options: { shouldCreateUser: false } });
    } else if (isResend) {
      result = await supabase.auth.resend({ type: 'email_change', email: address });
    } else {
      result = await supabase.auth.updateUser({ email: address });
    }
    if (result.error) {
      setError(describeAuthError(result.error));
      return;
    }
    // If the project has email confirmation switched off, the email is attached immediately
    // and there is no code to enter.
    const u = result.data && result.data.user;
    if (targetMode === 'secure' && !isResend && u && u.email === address && !u.new_email) {
      onDone('Your account is secured');
      return;
    }
    setMode(targetMode);
    setStep('code');
    setCode('');
    setCooldown(RESEND_SECONDS);
  });

  const verifySignIn = (token) => run(async () => {
    const { error: err } = await supabase.auth.verifyOtp({ email: address, token, type: 'email' });
    if (err) { setError(describeAuthError(err)); return; }
    onDone('Signed in');
  });

  const confirm = async () => {
    const token = code.replace(/\D/g, '');
    if (token.length !== 6) {
      setError({ kind: 'badcode', message: 'Enter the 6-digit code from the email.' });
      return;
    }
    if (mode === 'secure') {
      run(async () => {
        const { error: err } = await supabase.auth.verifyOtp({ email: address, token, type: 'email_change' });
        if (err) { setError(describeAuthError(err)); return; }
        onDone('Your account is secured');
      });
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const hasData = await userHasData(userId);
    busyRef.current = false;
    setBusy(false);
    if (!hasData) { verifySignIn(token); return; }
    Alert.alert(
      'Replace what’s on this phone?',
      'Signing in will replace what’s on this phone with your secured account. Notes and saved cards made on this phone before signing in will be lost.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign in', style: 'destructive', onPress: () => verifySignIn(token) },
      ]
    );
  };

  const switchToSignIn = () => { setError(null); setMode('signin'); setStep('email'); };
  const switchToSecure = () => { setError(null); setMode('secure'); setStep('email'); };
  const isSignIn = mode === 'signin';
  const title = isSignIn ? 'Sign in' : 'Secure your account';

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScreenHeader title={title} backLabel="Profile" onBack={onBack} collapsed={false} />
        <ScrollView contentContainerStyle={styles.secureContent} keyboardShouldPersistTaps="handled">
          <ScreenTitleBlock title={title} />

          {step === 'email' ? (
            <View key="email">
              <Text style={styles.secureHelp}>
                {isSignIn
                  ? 'Enter the email on your secured account and we’ll send you a 6-digit code.'
                  : 'Add your email so your notes, saved cards and conversations survive a new phone or a reinstall. We’ll send you a 6-digit code — no password needed.'}
              </Text>
              <TextInput
                style={styles.secureInput}
                value={email}
                onChangeText={(t) => { setEmail(t); setError(null); }}
                placeholder="you@example.com"
                placeholderTextColor={COLORS.textMuted}
                keyboardType="email-address"
                textContentType="emailAddress"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={() => sendCode()}
                editable={!busy}
              />
              {error && <Text style={styles.secureError}>{error.message}</Text>}
              {error && error.kind === 'exists' && (
                <Pressable onPress={() => sendCode('signin')} style={pressableStyle(styles.secureLink)} disabled={busy}>
                  <Text style={styles.secureLinkText}>Sign in to that account instead</Text>
                </Pressable>
              )}
              <Pressable
                style={pressableStyle([styles.primaryButton, busy && { opacity: 0.5 }])}
                onPress={() => sendCode()}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={COLORS.primaryText} /> : <Text style={styles.primaryButtonText}>Send code</Text>}
              </Pressable>
              {isSignIn ? (
                <Pressable onPress={switchToSecure} style={pressableStyle(styles.secureLink)}>
                  <Text style={styles.secureLinkText}>Secure this phone’s account instead</Text>
                </Pressable>
              ) : (
                <Pressable onPress={switchToSignIn} style={pressableStyle(styles.secureLink)}>
                  <Text style={styles.secureLinkText}>Already secured an account? Sign in</Text>
                </Pressable>
              )}
            </View>
          ) : (
            <View key="code">
              <Text style={styles.secureHelp}>Enter the 6-digit code we sent to {address}</Text>
              <TextInput
                style={[styles.secureInput, styles.secureCodeInput]}
                value={code}
                onChangeText={(t) => { setCode(t.replace(/\D/g, '').slice(0, 6)); setError(null); }}
                placeholder="000000"
                placeholderTextColor={COLORS.textMuted}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                editable={!busy}
              />
              {error && <Text style={styles.secureError}>{error.message}</Text>}
              <Pressable
                style={pressableStyle([styles.primaryButton, busy && { opacity: 0.5 }])}
                onPress={confirm}
                disabled={busy}
              >
                {busy ? <ActivityIndicator color={COLORS.primaryText} /> : <Text style={styles.primaryButtonText}>Confirm</Text>}
              </Pressable>
              <Pressable
                onPress={() => sendCode(mode, true)}
                disabled={busy || cooldown > 0}
                style={pressableStyle([styles.secureLink, (busy || cooldown > 0) && { opacity: 0.5 }])}
              >
                <Text style={styles.secureLinkText}>{cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}</Text>
              </Pressable>
              <Pressable onPress={() => { setError(null); setStep('email'); }} style={pressableStyle(styles.secureLink)}>
                <Text style={[styles.secureLinkText, { color: COLORS.textTertiary }]}>Use a different email</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

// Secured users: shows the email and Sign out. Signing out leaves this phone with a brand-new
// anonymous account (App's signOutAndReset), exactly like a first launch.
function AccountScreen({ onBack, onDone }) {
  const { userId, authUser, signOutAndReset } = useContext(UserContext);
  const [busy, setBusy] = useState(false);
  // Sharing profile (handle + display name): loaded here so it can be edited.
  const [profileState, setProfileState] = useState({ loading: true, profile: null, failed: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { profile, error } = await fetchMyProfile(userId);
      if (!cancelled) setProfileState({ loading: false, profile: profile || null, failed: !!error });
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const doSignOut = async () => {
    setBusy(true);
    const result = await signOutAndReset();
    setBusy(false);
    if (result && result.error) {
      Alert.alert('Couldn’t sign out', 'Something went wrong. Please try again.');
      return;
    }
    onDone('Signed out');
  };

  const confirmSignOut = () => {
    Alert.alert(
      'Sign out?',
      'Signing out leaves this phone with a fresh, empty account until you sign in again. Your notes, saved cards and conversations stay safe in your secured account.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: doSignOut },
      ]
    );
  };

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="Account" backLabel="Profile" onBack={onBack} collapsed={false} />
      <ScrollView contentContainerStyle={styles.secureContent} keyboardShouldPersistTaps="handled">
        <ScreenTitleBlock title="Account" />

        <View style={[styles.gameHubCard, SHADOW]}>
          <View style={[styles.gameHubIconWrap, { backgroundColor: 'rgba(184,134,11,0.15)' }]}>
            <Ionicons name="shield-checkmark-outline" size={26} color={COLORS.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.gameHubTitle}>Your account is secured</Text>
            <Text style={styles.gameHubDesc} numberOfLines={1}>{authUser.email}</Text>
          </View>
        </View>

        <Pressable style={pressableStyle([styles.gameHubCard, SHADOW, busy && { opacity: 0.5 }])} onPress={confirmSignOut} disabled={busy}>
          <View style={[styles.gameHubIconWrap, { backgroundColor: 'rgba(255,122,114,0.15)' }]}>
            {busy ? <ActivityIndicator color={COLORS.danger} /> : <Ionicons name="log-out-outline" size={26} color={COLORS.danger} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.gameHubTitle, { color: COLORS.danger }]}>Sign out</Text>
          </View>
        </Pressable>

        <Text style={[styles.groupSectionLabel, { marginTop: SPACING.lg }]}>Sharing profile</Text>
        {profileState.loading ? (
          <ActivityIndicator color={COLORS.primary} />
        ) : profileState.failed ? (
          <Text style={styles.secureHelp}>Your sharing profile isn't available right now.</Text>
        ) : (
          <View>
            <Text style={styles.secureHelp}>
              {profileState.profile
                ? 'Friends send you cards using your handle.'
                : 'Choose a handle so friends can send you cards.'}
            </Text>
            <ProfileForm
              key={profileState.profile ? profileState.profile.handle : 'new'}
              userId={userId}
              initial={profileState.profile}
              submitLabel={profileState.profile ? 'Save profile' : 'Create profile'}
              onSaved={(p) => setProfileState({ loading: false, profile: p, failed: false })}
            />
          </View>
        )}
      </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}


// =====================================================================================
// Tabs: Home, Learn, Library, Games, Profile
// The five tab screens stay mounted once visited (App() hides the inactive ones), so going
// "back" from a card, feed or game returns to the same tab at the same scroll position. Each
// tab refetches quietly when it regains focus (useRefetchOnFocus).
// =====================================================================================
const TAB_LABELS = { home: 'Home', learn: 'Learn', library: 'Library', games: 'Play', profile: 'Profile' };

// Calls fn whenever `focused` flips to true after the first render (the screen's own mount
// effect does the initial load).
function useRefetchOnFocus(focused, fn) {
  const first = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (focused) fnRef.current();
  }, [focused]);
}

// Same markup as the search field inside ScreenTitleBlock, for screens that place it themselves.
function SearchField({ value, onChangeText, placeholder }) {
  return (
    <View style={styles.screenSearchField}>
      <Ionicons name="search" size={18} color={COLORS.textTertiary} />
      <TextInput
        style={styles.searchInput}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textMuted}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {value.length > 0 && (
        <Pressable onPress={() => onChangeText('')} hitSlop={8}>
          <Ionicons name="close-circle" size={18} color={COLORS.textTertiary} />
        </Pressable>
      )}
    </View>
  );
}

// options: [{ key, label, dot }]
function SegmentedControl({ options, value, onChange }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const selected = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={o.dot ? `${o.label}, new items` : o.label}
            style={pressableStyle([styles.segment, selected && styles.segmentSelected])}
          >
            <Text
              style={[styles.segmentText, selected && styles.segmentTextSelected]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
            >
              {o.label}
            </Text>
            {!!o.dot && <View style={styles.segmentDot} />}
          </Pressable>
        );
      })}
    </View>
  );
}

// ---- Category stats ("12 of 18 seen"), from the concepts table + this user's card_activity ----
// "Seen" = the card has been on screen long enough to count (card_activity.view_count > 0).
function useCategoryStats(userId, focused) {
  const [concepts, setConcepts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  useActivityVersion();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data, error }] = await Promise.all([
        supabase.from('concepts').select('id, title, hook, category').order('title', { ascending: true }),
        ensureActivityLoaded(userId),
      ]);
      if (cancelled) return;
      if (!error && data) setConcepts(data);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Viewing a card updates the activity cache without notifying, so recompute on focus.
  useRefetchOnFocus(focused, () => setTick((t) => t + 1));

  const byCat = {};
  Object.keys(CATEGORY_LABELS).forEach((k) => { byCat[k] = { key: k, total: 0, seen: 0 }; });
  concepts.forEach((c) => {
    const b = byCat[c.category] || (byCat[c.category] = { key: c.category, total: 0, seen: 0 });
    b.total += 1;
    const e = getActivityEntry(c.id);
    if (e && e.viewCount > 0) b.seen += 1;
  });
  const stats = Object.values(byCat).filter((b) => b.total > 0);
  return { concepts, loading, stats };
}

// ---------------------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------------------
async function fetchFriendsState(userId) {
  if (!userId) return { kind: 'none' };
  // 1. Latest unread "Shared with you" item (blocked senders are already excluded by RLS).
  const { data: unread, error } = await supabase
    .from('shares')
    .select('id, sender_id, concept_id, question, note, created_at')
    .eq('recipient_id', userId)
    .is('opened_at', null)
    .is('recipient_hidden_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!error && unread && unread.length) {
    const s = unread[0];
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from('profiles').select('display_name').eq('user_id', s.sender_id).maybeSingle(),
      supabase.from('concepts').select('id, title').eq('id', s.concept_id).maybeSingle(),
    ]);
    if (c) {
      return {
        kind: 'unread',
        share: { ...s, senderName: s.sender_id === userId ? 'You' : (p && p.display_name) || 'Someone', title: c.title },
      };
    }
  }
  // 2. The card I most recently shared (either way).
  const { data: sent, error: sentErr } = await supabase
    .from('shares')
    .select('concept_id, created_at')
    .eq('sender_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (!sentErr && sent && sent.length) {
    const { data: c } = await supabase.from('concepts').select('*').eq('id', sent[0].concept_id).maybeSingle();
    if (c) return { kind: 'sent', concept: c, at: sent[0].created_at };
  }
  // 3. Nothing yet.
  return { kind: 'none' };
}

// "today", "yesterday", "on Monday" (within a week) or "on 14 Sep".
function formatSentWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const sixDaysAgo = new Date(startOfToday);
  sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);
  if (d >= startOfToday) return 'today';
  if (d >= startOfYesterday) return 'yesterday';
  if (d >= sixDaysAgo) return `on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]}`;
  return `on ${formatShortDate(iso)}`;
}

function HomeScreen({ focused, onOpenCard, onOpenDailyThree, onOpenShared, onOpenPrepare }) {
  const { userId } = useContext(UserContext);
  const [picks, setPicks] = useState([]);
  const [friends, setFriends] = useState({ kind: 'none' });
  const [shareOpen, setShareOpen] = useState(false);
  const [askMode, setAskMode] = useState(null);
  const [debateQuestion, setDebateQuestion] = useState(null);
  const [noteConcept, setNoteConcept] = useState(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('concepts').select('*').order('created_at', { ascending: true });
      if (!error && data && data.length > 0) setPicks(pickDailyThree(data));
    })();
  }, []);

  const loadFriends = useCallback(async () => {
    setFriends(await fetchFriendsState(userId));
  }, [userId]);
  useEffect(() => { loadFriends(); }, [loadFriends]);
  useRefetchOnFocus(focused, loadFriends);
  useRefreshOnForeground(loadFriends);

  const card = picks[0] || null;
  const question = card ? card.discussion_question || '' : '';
  const catColor = card ? CATEGORY_COLORS[card.category] || COLORS.textTertiary : COLORS.textTertiary;
  const moreCount = Math.max(0, picks.length - 1);

  let friendsRow;
  if (friends.kind === 'unread') {
    const s = friends.share;
    friendsRow = {
      unread: true,
      text: s.question ? `${s.senderName} asked: ${s.question}` : `${s.senderName} shared ${s.title} with you`,
      onPress: () => {
        markShareOpened(s.id);
        onOpenShared({ concept_id: s.concept_id, senderName: s.senderName, question: s.question, note: s.note, shareId: s.id });
      },
    };
  } else if (friends.kind === 'sent') {
    friendsRow = {
      text: `You sent ${friends.concept.title} ${formatSentWhen(friends.at)}. How did the conversation go?`,
      onPress: () => setNoteConcept(friends.concept),
    };
  } else {
    friendsRow = {
      text: "Send today's idea to someone you'd enjoy discussing it with.",
      onPress: () => card && setShareOpen(true),
    };
  }

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={[styles.homeContainer, { paddingTop: 4 }]} showsVerticalScrollIndicator={false}>
        {/* Hero */}
        <View style={styles.heroRow}>
          <View>
            <Wordmark
              size={40}
              smallCaps={0.8}
              letterSpacing={2}
              offsetY={16}
              suffixStyle={styles.wordmarkSuffix}
              style={{ marginBottom: 4 }}
            />
            <Text style={styles.homeSubtitle}>{APP_TAGLINE}</Text>
          </View>
          {/* Header icon: transparent PNG cut from the new icon (900x671, same shape and edge padding as the previous mark). */}
          <Image source={require('./assets/kepos-rich-mark.png')} style={styles.headerIcon} resizeMode="contain" accessibilityLabel={APP_NAME} />
        </View>

        {/* Today's conversation */}
        <Text style={[styles.groupSectionLabel, { marginTop: SPACING.sm }]}>Today's conversation</Text>
        {card ? (
          <View style={[styles.convoCard, SHADOW]}>
            <Pressable onPress={() => onOpenCard(card.id, picks.map((p) => p.id))} style={pressableStyle(null)} accessibilityRole="button" accessibilityLabel={`Open ${card.title}`}>
              <View style={styles.categoryRow}>
                <View style={[styles.categoryDot, { backgroundColor: catColor }]} />
                <Text style={[styles.category, { color: catColor }]}>{CATEGORY_LABELS[card.category] ?? card.category}</Text>
              </View>
              <Text style={styles.convoTitle}>{card.title}</Text>
              <Text style={styles.convoHook}>{card.hook}</Text>
              {!!question && (
                <View>
                  <View style={styles.convoDivider} />
                  <Text style={styles.convoLabel}>WORTH DISCUSSING</Text>
                  <Text style={styles.convoQuestion}>{question}</Text>
                </View>
              )}
            </Pressable>

            <Pressable
              style={pressableStyle([styles.primaryButton, { marginTop: SPACING.md }])}
              onPress={() => { setDebateQuestion(question || null); setAskMode('debate'); }}
            >
              <Text style={styles.primaryButtonText}>Talk it through</Text>
            </Pressable>
            <Pressable
              style={pressableStyle([styles.askSecondaryButton, { marginBottom: 0 }])}
              onPress={() => setShareOpen(true)}
            >
              <Text style={styles.askSecondaryButtonText}>Send to a friend</Text>
            </Pressable>
          </View>
        ) : (
          <ActivityIndicator color={COLORS.primary} style={{ marginVertical: SPACING.xl }} />
        )}

        {moreCount > 0 && (
          <Pressable onPress={onOpenDailyThree} style={pressableStyle(styles.moreIdeasLink)} accessibilityRole="link">
            <Text style={styles.moreIdeasLinkText}>
              {moreCount} more idea{moreCount === 1 ? '' : 's'} today
            </Text>
            <Ionicons name="chevron-forward" size={14} color={COLORS.primary} />
          </Pressable>
        )}

        {/* With friends */}
        <Text style={[styles.groupSectionLabel, { marginTop: SPACING.md }]}>With friends</Text>
        <Pressable style={pressableStyle(styles.friendsRow)} onPress={friendsRow.onPress}>
          {friendsRow.unread && <View style={styles.unreadDot} />}
          <Text style={styles.friendsRowText} numberOfLines={3}>{friendsRow.text}</Text>
          <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
        </Pressable>
        <Pressable style={pressableStyle([styles.friendsRow, { marginTop: SPACING.sm }])} onPress={onOpenPrepare} accessibilityRole="button">
          <Ionicons name="people-outline" size={20} color={COLORS.textTertiary} />
          <Text style={styles.friendsRowText}>Prepare for a conversation</Text>
          <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
        </Pressable>
      </ScrollView>

      {card && <ShareSheet visible={shareOpen} concept={card} onClose={() => setShareOpen(false)} />}
      {card && (
        <AskAgoraConversation
          visible={!!askMode}
          mode={askMode}
          concept={card}
          userId={userId}
          discussionQuestion={debateQuestion}
          existingConversation={null}
          onNoteChanged={() => {}}
          onClose={() => { setAskMode(null); setDebateQuestion(null); }}
        />
      )}
      <NoteEditorScreen
        visible={!!noteConcept}
        concept={noteConcept}
        userId={userId}
        onClose={() => setNoteConcept(null)}
        onOpenCard={() => {
          const id = noteConcept && noteConcept.id;
          setNoteConcept(null);
          if (id) onOpenCard(id);
        }}
        onNoteChanged={() => {}}
      />
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------------------
// LEARN (search + Random Mix + least explored + categories)
// ---------------------------------------------------------------------------------------
function LearnScreen({ focused, onOpenFeed, onSelectCard }) {
  const { userId } = useContext(UserContext);
  const { concepts, loading, stats } = useCategoryStats(userId, focused);
  const [showAll, setShowAll] = useState(false);
  const { collapsed, onScroll } = useCollapsingTitle();

  // No search field any more: the only list view is "Browse all ideas A–Z".
  const searching = showAll;
  const filtered = concepts;

  // The category I've seen the smallest share of (ties: the bigger category).
  const least = stats.length
    ? [...stats].sort((a, b) => a.seen / a.total - b.seen / b.total || b.total - a.total)[0]
    : null;
  const orderedStats = Object.keys(CATEGORY_LABELS)
    .map((k) => stats.find((s) => s.key === k))
    .filter(Boolean);

  const header = (
    <View>
      <ScreenTitleBlock title="Learn" />
      {!searching && (
        <View>
          <Pressable style={pressableStyle([styles.primaryButton, SHADOW])} onPress={() => onOpenFeed(null)}>
            <Ionicons name="shuffle-outline" size={20} color={COLORS.primaryText} />
            <Text style={styles.primaryButtonText}>Random Mix</Text>
          </Pressable>

          {least && (
            <View style={{ marginBottom: SPACING.md }}>
              <Text style={styles.groupSectionLabel}>LEAST EXPLORED</Text>
              <Pressable style={pressableStyle(styles.learnRow)} onPress={() => onOpenFeed(least.key)}>
                <View style={[styles.categoryDot, { backgroundColor: CATEGORY_COLORS[least.key] || COLORS.textTertiary }]} />
                <Text style={styles.learnRowText}>
                  {CATEGORY_LABELS[least.key] ?? least.key} · {least.seen} of {least.total} seen
                </Text>
                <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
              </Pressable>
            </View>
          )}

          <Text style={styles.groupSectionLabel}>TOPICS</Text>
          <View style={styles.learnGrid}>
            {orderedStats.map((s) => (
              <Pressable key={s.key} style={pressableStyle(styles.learnTile)} onPress={() => onOpenFeed(s.key)}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  <View style={[styles.categoryDot, { backgroundColor: CATEGORY_COLORS[s.key] || COLORS.textTertiary, marginTop: 6 }]} />
                  <Text style={styles.learnTileTitle}>{CATEGORY_LABELS[s.key] ?? s.key}</Text>
                </View>
                <Text style={styles.learnTileCount}>{s.seen} of {s.total} seen</Text>
              </Pressable>
            ))}
          </View>

          <Pressable style={pressableStyle([styles.learnRow, { marginTop: SPACING.md }])} onPress={() => setShowAll(true)}>
            <Ionicons name="list-outline" size={18} color={COLORS.textTertiary} />
            <Text style={styles.learnRowText}>Browse all ideas A–Z</Text>
            <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
          </Pressable>
        </View>
      )}
      {showAll && (
        <Pressable onPress={() => setShowAll(false)} style={pressableStyle(styles.secureLink)}>
          <Text style={styles.secureLinkText}>Back to topics</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <ScreenHeader title="Learn" collapsed={collapsed} compact />
      <FlatList
        contentContainerStyle={styles.tabListContent}
        data={searching ? filtered : []}
        {...(Platform.OS === 'web' ? { initialNumToRender: Math.max(filtered.length, 10), maxToRenderPerBatch: Math.max(filtered.length, 10) } : {})}
        keyExtractor={(item) => item.id}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        renderItem={({ item }) => {
          const catColor = CATEGORY_COLORS[item.category] || COLORS.textTertiary;
          return (
            <Pressable style={pressableStyle(styles.browseRow)} onPress={() => onSelectCard(item.id, filtered.map((c) => c.id))}>
              <View style={[styles.categoryDot, { backgroundColor: catColor, marginRight: 10 }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.browseRowTitle}>{item.title}</Text>
                <Text style={styles.browseRowHook} numberOfLines={1}>{item.hook}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
            </Pressable>
          );
        }}
        ListEmptyComponent={
          loading ? <ActivityIndicator color={COLORS.primary} size="large" style={{ marginTop: 40 }} />
            : null
        }
      />
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------------------
// GAMES
// ---------------------------------------------------------------------------------------
function GamesScreen({ focused, onOpen, onOpenCard }) {
  const { userId } = useContext(UserContext);
  const [quizDone, setQuizDone] = useState(null);
  const [streak, setStreak] = useState(0);
  const [explainConcept, setExplainConcept] = useState(null);
  const [explainHint, setExplainHint] = useState(null);
  const { collapsed, onScroll } = useCollapsingTitle();

  // Explain it back: pick one card the user has already seen — preferring cards seen more than a
  // day ago that they haven't explained yet; then any unexplained seen card; then any seen card.
  const startExplain = async () => {
    setExplainHint(null);
    if (!userId) return;
    await ensureActivityLoaded(userId);
    const seen = [];
    activityMap.forEach((entry, id) => {
      if (entry && entry.viewCount > 0) seen.push({ id, lastSeenAt: entry.lastSeenAt });
    });
    if (seen.length === 0) {
      setExplainHint('Read a few cards in Learn first, then come back to explain one.');
      return;
    }
    const { data: explainedRows } = await supabase
      .from('ai_conversations')
      .select('concept_id')
      .eq('user_id', userId)
      .eq('mode', 'explain');
    const explained = new Set((explainedRows || []).map((r) => r.concept_id));
    const dayAgo = Date.now() - 86400000;
    const unexplained = seen.filter((s) => !explained.has(s.id));
    const older = unexplained.filter((s) => s.lastSeenAt && new Date(s.lastSeenAt).getTime() < dayAgo);
    const pool = older.length ? older : unexplained.length ? unexplained : seen;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const { data: concept } = await supabase.from('concepts').select('*').eq('id', pick.id).maybeSingle();
    if (concept) setExplainConcept(concept);
    else setExplainHint("Couldn't load a card just now. Please try again.");
  };

  const load = useCallback(async () => {
    const deviceId = await getDeviceId();
    const { data, error } = await supabase.from('quiz_results').select('quiz_date').eq('device_id', deviceId);
    if (!error && data) {
      setQuizDone(data.some((r) => r.quiz_date === todayStr()));
      setStreak(calcStreak(data.map((r) => r.quiz_date)));
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefetchOnFocus(focused, load);

  const games = [
    {
      key: 'quiz',
      icon: 'flash-outline',
      title: 'Daily Quiz',
      desc: quizDone === null ? 'A fresh quiz every day.' : quizDone ? "Done for today — a new one tomorrow." : "Today's quiz is waiting.",
      done: quizDone === true,
      streak,
    },
    {
      key: 'explain',
      icon: 'chatbubble-ellipses-outline',
      title: 'Explain it back',
      desc: "Pick an idea you've read and say it in your own words.",
    },
    { key: 'crossword', icon: 'grid-outline', title: 'Daily Crossword', desc: 'A fresh mini crossword every day, built from your concepts.' },
    { key: 'truthLie', icon: 'help-circle-outline', title: 'Truth or Lie', desc: 'Spot the fake statement among three, across a run of random cards.' },
    { key: 'emoji', icon: 'happy-outline', title: 'Emoji Riddle', desc: 'Guess the concept from three emojis — great to play with friends.' },
    { key: 'quizHistory', icon: 'stats-chart-outline', title: 'Quiz History', desc: 'See your past scores and streak record.' },
  ];

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <ScreenHeader title="Play" collapsed={collapsed} compact />
      <ScrollView contentContainerStyle={styles.tabListContent} onScroll={onScroll} scrollEventThrottle={16}>
        <ScreenTitleBlock title="Play" />
        {games.map((g) => (
          <View key={g.key}>
          <Pressable style={pressableStyle([styles.gameHubCard, SHADOW])} onPress={() => (g.key === 'explain' ? startExplain() : onOpen(g.key))}>
            <View style={[styles.gameHubIconWrap, { backgroundColor: 'rgba(184,134,11,0.15)' }]}>
              <Ionicons name={g.icon} size={26} color={COLORS.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.gameHubTitle}>{g.title}</Text>
              <Text style={styles.gameHubDesc}>{g.desc}</Text>
            </View>
            {g.done && <Ionicons name="checkmark-circle" size={20} color={COLORS.success} />}
            {!!g.streak && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Ionicons name="flame" size={14} color={COLORS.primary} />
                <Text style={styles.streakCornerText}>{g.streak}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={20} color={COLORS.textTertiary} />
          </Pressable>
          {g.key === 'explain' && !!explainHint && (
            <Text style={[styles.gameHubDesc, { marginTop: -SPACING.xs, marginBottom: SPACING.md, paddingHorizontal: SPACING.xs }]}>{explainHint}</Text>
          )}
          </View>
        ))}
      </ScrollView>

      {explainConcept && (
        <AskAgoraConversation
          visible
          mode="explain"
          concept={explainConcept}
          userId={userId}
          discussionQuestion={null}
          existingConversation={null}
          onNoteChanged={() => {}}
          onClose={() => setExplainConcept(null)}
          onSeeCard={() => onOpenCard && onOpenCard(explainConcept.id)}
        />
      )}
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------------------
// LIBRARY: Notes / Saved / Conversations / Shared — the old screens' lists, moved here
// ---------------------------------------------------------------------------------------
const LIBRARY_SEGMENTS = [
  { key: 'notes', label: 'Notes' },
  { key: 'saved', label: 'Saved' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'shared', label: 'Shared' },
];

function LibraryEmpty({ loading, errorMsg, searchActive, hasAny, icon, text }) {
  if (loading) return <ActivityIndicator color={COLORS.primary} size="large" style={{ marginTop: 40 }} />;
  if (errorMsg) return <Text style={{ color: COLORS.error, fontSize: 13, fontFamily: 'monospace' }}>{errorMsg}</Text>;
  if (searchActive && hasAny) return <Text style={styles.emptyText}>No matches.</Text>;
  return (
    <View style={{ alignItems: 'center', paddingTop: SPACING.xxl }}>
      <Ionicons name={icon} size={40} color={COLORS.textTertiary} style={{ marginBottom: 12 }} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function NotesList({ query, sortKey, header, onScroll, onSelectCard, focused }) {
  const { userId } = useContext(UserContext);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [activeNoteConcept, setActiveNoteConcept] = useState(null);
  const [activeInitialNoteId, setActiveInitialNoteId] = useState(null);
  const { pendingDelete, beginDelete, undo } = useUndoableDelete();

  const loadNotes = useCallback(async (silent) => {
    if (silent !== true) setLoading(true);
    setErrorMsg(null);
    const { notes: fetched, error } = await fetchMyNotes(userId);
    if (error) setErrorMsg(JSON.stringify(error, null, 2));
    else setNotes(fetched);
    setLoading(false);
  }, [userId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);
  useRefetchOnFocus(focused, () => loadNotes(true));

  const q = query.trim().toLowerCase();
  const filtered = q
    ? notes.filter((n) => n.concept.title.toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q))
    : notes;
  const sections = groupBySort(filtered, sortKey, (n) => n.concept.category, (n) => n.concept.title);

  // The row represents the whole card, not one note — deleting it removes every note that
  // card has, per "based per card, not per note."
  const handleSwipeDelete = (item) => {
    setNotes((prev) => prev.filter((n) => n.concept_id !== item.concept_id));
    beginDelete(item, (it) => deleteAllNotesForConcept(userId, it.concept_id));
  };

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        contentContainerStyle={styles.tabListContent}
        data={loading || errorMsg ? [] : sections}
        keyExtractor={(s) => s.key}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListFooterComponent={
          notes.length > 0 ? (
            <Text style={styles.screenCountFooter}>{notes.length} note{notes.length === 1 ? '' : 's'}</Text>
          ) : null
        }
        renderItem={({ item: section }) => (
          <View style={{ marginBottom: SPACING.lg }}>
            <Text style={styles.groupSectionLabel}>{section.label}</Text>
            <View style={styles.groupContainer}>
              {section.items.map((item, idx) => {
                const c = item.concept;
                const catColor = CATEGORY_COLORS[c.category] || COLORS.textTertiary;
                return (
                  <Swipeable
                    key={item.concept_id}
                    renderRightActions={() => (
                      <Pressable onPress={() => handleSwipeDelete(item)} style={styles.swipeDeleteAction}>
                        <Ionicons name="trash-outline" size={20} color="#fff" />
                        <Text style={styles.swipeDeleteText}>Delete</Text>
                      </Pressable>
                    )}
                  >
                    <Pressable
                      style={[styles.groupRow, idx > 0 && styles.groupRowDivider]}
                      onPress={() => { setActiveNoteConcept(c); setActiveInitialNoteId(item.note_id); }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={styles.savedCardTitle}>{c.title}</Text>
                        {item.count > 1 && (
                          <View style={styles.notesCountBadge}>
                            <Text style={styles.notesCountBadgeText}>{item.count}</Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.groupRowMeta}>
                        <Text style={styles.groupRowTime}>{formatRelativeTime(item.updated_at)}</Text>
                        <View style={[styles.categoryDot, { backgroundColor: catColor, marginHorizontal: 6 }]} />
                        <Text style={styles.groupRowPreview} numberOfLines={1}>{previewFromBody(item.body)}</Text>
                      </View>
                    </Pressable>
                  </Swipeable>
                );
              })}
            </View>
          </View>
        )}
        ListEmptyComponent={
          <LibraryEmpty
            loading={loading}
            errorMsg={errorMsg}
            searchActive={q.length > 0}
            hasAny={notes.length > 0}
            icon="document-text-outline"
            text="No notes yet. Tap the note icon on any card to jot one down."
          />
        }
      />

      <NoteEditorScreen
        visible={!!activeNoteConcept}
        concept={activeNoteConcept}
        userId={userId}
        initialNoteId={activeInitialNoteId}
        onClose={() => { setActiveNoteConcept(null); loadNotes(); }}
        onOpenCard={() => {
          if (activeNoteConcept) {
            const ids = notes.map((n) => n.concept_id);
            const id = activeNoteConcept.id;
            setActiveNoteConcept(null);
            onSelectCard(id, ids);
          }
        }}
        onNoteChanged={() => loadNotes()}
      />

      <UndoToast visible={!!pendingDelete} label="Note deleted" onUndo={() => undo(loadNotes)} />
    </View>
  );
}

function SavedList({ query, sortKey, header, onScroll, onSelectCard, focused }) {
  const { userId } = useContext(UserContext);
  const [loading, setLoading] = useState(true);
  const [savedConcepts, setSavedConcepts] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [activeCategory, setActiveCategory] = useState(null);

  const load = useCallback(async (silent) => {
    if (silent !== true) setLoading(true);
    setErrorMsg(null);
    const { concepts, error } = await fetchSavedConcepts(userId);
    if (error) {
      setErrorMsg(JSON.stringify(error, null, 2));
    } else {
      setSavedConcepts(concepts);
      setActiveCategory((cur) => (cur && concepts.some((c) => c.category === cur) ? cur : null));
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);
  useRefetchOnFocus(focused, () => load(true));

  const q = query.trim().toLowerCase();
  const categoriesPresent = useMemo(
    () => Array.from(new Set(savedConcepts.map((c) => c.category))),
    [savedConcepts]
  );
  const byCategory = activeCategory ? savedConcepts.filter((c) => c.category === activeCategory) : savedConcepts;
  const filteredConcepts = q
    ? byCategory.filter((c) => c.title.toLowerCase().includes(q) || (c.hook && c.hook.toLowerCase().includes(q)))
    : byCategory;
  // 'recent' is the order they came back in (most recently saved first).
  const visibleConcepts =
    sortKey === 'category'
      ? [...filteredConcepts].sort((a, b) => (CATEGORY_LABELS[a.category] ?? a.category).localeCompare(CATEGORY_LABELS[b.category] ?? b.category))
      : sortKey === 'az'
        ? [...filteredConcepts].sort((a, b) => a.title.localeCompare(b.title))
        : filteredConcepts;

  const chips = categoriesPresent.length > 1 ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.filterRow}
      contentContainerStyle={{ paddingRight: SPACING.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <Pressable
        style={pressableStyle([styles.filterChip, activeCategory === null && [styles.filterChipActive, { borderColor: COLORS.textPrimary }]])}
        onPress={() => setActiveCategory(null)}
      >
        <Text style={[styles.filterChipText, activeCategory === null && styles.filterChipTextActive]}>All</Text>
      </Pressable>
      {categoriesPresent.map((cat) => {
        const catColor = CATEGORY_COLORS[cat] || COLORS.textTertiary;
        const isActive = activeCategory === cat;
        return (
          <Pressable
            key={cat}
            style={pressableStyle([styles.filterChip, isActive && [styles.filterChipActive, { borderColor: catColor }]])}
            onPress={() => setActiveCategory(cat)}
          >
            <View style={[styles.filterChipDot, { backgroundColor: catColor }]} />
            <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>{CATEGORY_LABELS[cat] ?? cat}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  ) : null;

  return (
    <FlatList
      contentContainerStyle={styles.tabListContent}
      data={loading || errorMsg ? [] : visibleConcepts}
      keyExtractor={(item) => item.id}
      onScroll={onScroll}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<View>{header}{chips}</View>}
      ListFooterComponent={
        savedConcepts.length > 0 ? (
          <Text style={styles.screenCountFooter}>
            {savedConcepts.length} card{savedConcepts.length === 1 ? '' : 's'} saved
          </Text>
        ) : null
      }
      renderItem={({ item }) => {
        const catColor = CATEGORY_COLORS[item.category] || COLORS.textTertiary;
        return (
          <Pressable style={pressableStyle(styles.savedCard)} onPress={() => onSelectCard(item.id, visibleConcepts.map((c) => c.id))}>
            <View style={styles.savedCardCategoryRow}>
              <View style={[styles.categoryDot, { backgroundColor: catColor }]} />
              <Text style={[styles.category, { color: catColor }]}>{CATEGORY_LABELS[item.category] ?? item.category}</Text>
            </View>
            <Text style={styles.savedCardTitle}>{item.title}</Text>
            <Text style={styles.savedCardHook} numberOfLines={2}>{item.hook}</Text>
          </Pressable>
        );
      }}
      ListEmptyComponent={
        <LibraryEmpty
          loading={loading}
          errorMsg={errorMsg}
          searchActive={q.length > 0}
          hasAny={savedConcepts.length > 0}
          icon="bookmark-outline"
          text="Nothing saved yet. Tap the star on any card to keep it here."
        />
      }
    />
  );
}

function ConversationsList({ query, activeFilter, filterConceptId, header, onScroll, focused, onSelectCard, onOpenPlan }) {
  const { userId } = useContext(UserContext);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const [activeConversation, setActiveConversation] = useState(null);
  const { pendingDelete, beginDelete, undo } = useUndoableDelete();

  const loadConversations = useCallback(async (silent) => {
    if (silent !== true) setLoading(true);
    setErrorMsg(null);
    const [{ conversations: fetched, error }, planResult] = await Promise.all([
      fetchAllConversations(userId),
      fetchPlans(userId),
    ]);
    if (error) setErrorMsg(JSON.stringify(error, null, 2));
    else {
      // Prepare plans appear in the same list, newest first (a failed plans fetch just means none).
      const merged = [...fetched, ...(planResult.plans || [])].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      setConversations(merged);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { loadConversations(); }, [loadConversations]);
  useRefetchOnFocus(focused, () => loadConversations(true));

  const q = query.trim().toLowerCase();
  const filtered = conversations.filter((c) => {
    if (c.kind === 'plan') {
      // A plan isn't about one card, so it never shows in a single card's list.
      if (filterConceptId) return false;
      if (activeFilter !== 'all' && activeFilter !== 'prepare') return false;
      if (!q) return true;
      return (c.who || '').toLowerCase().includes(q) || (c.occasion || '').toLowerCase().includes(q);
    }
    if (filterConceptId && c.concept_id !== filterConceptId) return false;
    if (activeFilter !== 'all' && c.mode !== activeFilter) return false;
    if (!q) return true;
    if ((c.concept.title || '').toLowerCase().includes(q)) return true;
    return (c.messages || []).some((m) => (m.content || '').toLowerCase().includes(q));
  });
  const sections = bucketByDate(filtered, 'updated_at');

  const handleSwipeDelete = (item) => {
    setConversations((prev) => prev.filter((c) => c.id !== item.id));
    beginDelete(item, (it) => (it.kind === 'plan' ? deletePlanRow(it.id) : deleteConversationRow(it.id)));
  };

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        contentContainerStyle={styles.tabListContent}
        data={loading || errorMsg ? [] : sections}
        keyExtractor={(s) => s.key}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListFooterComponent={
          filtered.length > 0 ? (
            <Text style={styles.screenCountFooter}>
              {filtered.length} conversation{filtered.length === 1 ? '' : 's'}
            </Text>
          ) : null
        }
        renderItem={({ item: section }) => (
          <View style={{ marginBottom: SPACING.lg }}>
            <Text style={styles.groupSectionLabel}>{section.label}</Text>
            <View style={styles.groupContainer}>
              {section.items.map((item, idx) => (
                <Swipeable
                  key={item.id}
                  renderRightActions={() => (
                    <Pressable onPress={() => handleSwipeDelete(item)} style={styles.swipeDeleteAction}>
                      <Ionicons name="trash-outline" size={20} color="#fff" />
                      <Text style={styles.swipeDeleteText}>Delete</Text>
                    </Pressable>
                  )}
                >
                  <Pressable style={[styles.groupRow, idx > 0 && styles.groupRowDivider]} onPress={() => (item.kind === 'plan' ? onOpenPlan && onOpenPlan(item) : setActiveConversation(item))}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={styles.savedCardTitle} numberOfLines={1}>{item.kind === 'plan' ? item.who : item.concept.title}</Text>
                      {item.mode === 'debate' && item.status === 'ended' && (
                        <Text style={styles.debriefBadgeText}>Debrief</Text>
                      )}
                    </View>
                    <View style={styles.groupRowMeta}>
                      <Text style={styles.groupRowTime}>{formatRelativeTime(item.updated_at)}</Text>
                      <Ionicons name={item.kind === 'plan' ? 'people-outline' : ASK_AGORA_MODE_ICONS[item.mode]} size={12} color={COLORS.primary} style={{ marginHorizontal: 6 }} />
                      {(item.kind === 'plan' || item.mode === 'debate' || item.mode === 'explain') && (
                        <Text style={styles.conversationKindLabel}>
                          {item.kind === 'plan' ? 'Prepared' : item.mode === 'debate' ? 'Debate' : 'Explained'}
                        </Text>
                      )}
                      <Text style={styles.groupRowPreview} numberOfLines={1}>
                        {item.kind === 'plan' ? item.occasion : conversationPreviewText(item)}
                      </Text>
                    </View>
                  </Pressable>
                </Swipeable>
              ))}
            </View>
          </View>
        )}
        ListEmptyComponent={
          <LibraryEmpty
            loading={loading}
            errorMsg={errorMsg}
            searchActive={q.length > 0 || activeFilter !== 'all' || !!filterConceptId}
            hasAny={conversations.length > 0}
            icon="chatbubbles-outline"
            text="No conversations yet. Tap the sparkles on any card to start one."
          />
        }
      />

      {activeConversation && (
        <AskAgoraConversation
          visible={!!activeConversation}
          mode={activeConversation.mode}
          concept={activeConversation.concept}
          userId={userId}
          discussionQuestion={activeConversation.discussion_question}
          existingConversation={activeConversation}
          onNoteChanged={() => {}}
          onClose={() => { setActiveConversation(null); loadConversations(); }}
          onSeeCard={() => onSelectCard && onSelectCard(activeConversation.concept_id)}
        />
      )}

      <UndoToast visible={!!pendingDelete} label="Conversation deleted" onUndo={() => undo(loadConversations)} />
    </View>
  );
}

function SharedList({ query, header, onScroll, onOpenShared, focused }) {
  const { userId } = useContext(UserContext);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);
  const { pendingDelete, beginDelete, undo } = useUndoableDelete();

  const loadInbox = useCallback(async (silent) => {
    if (silent !== true) setLoading(true);
    setErrorMsg(null);
    const { items: fetched, error } = await fetchInbox(userId);
    if (error) setErrorMsg("Couldn't load what's been shared with you.");
    else setItems(fetched);
    setLoading(false);
  }, [userId]);

  useEffect(() => { loadInbox(); }, [loadInbox]);
  useRefetchOnFocus(focused, () => loadInbox(true));
  useRefreshOnForeground(() => loadInbox(true));

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((s) =>
        s.senderName.toLowerCase().includes(q) ||
        s.concept.title.toLowerCase().includes(q) ||
        (s.question || '').toLowerCase().includes(q) ||
        (s.note || '').toLowerCase().includes(q))
    : items;
  const sections = bucketByDate(filtered, 'created_at');

  const handleOpen = (item) => {
    if (!item.opened_at) markShareOpened(item.id);
    onOpenShared({
      concept_id: item.concept_id,
      senderName: item.senderName,
      question: item.question,
      note: item.note,
      shareId: item.id,
    });
  };

  const handleHide = (item) => {
    setItems((prev) => prev.filter((s) => s.id !== item.id));
    beginDelete(item, (it) => hideShareFromInbox(it.id));
  };

  const confirmBlock = (item) => {
    Alert.alert(
      `Block ${item.senderName}?`,
      "You won't see anything they send you from now on. They won't be told.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            const result = await blockUser(userId, item.sender_id);
            if (!result.ok) { Alert.alert("Couldn't block", 'Something went wrong. Please try again.'); return; }
            setItems((prev) => prev.filter((s) => s.sender_id !== item.sender_id));
          },
        },
      ]
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        contentContainerStyle={styles.tabListContent}
        data={loading || errorMsg ? [] : sections}
        keyExtractor={(s) => s.key}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        renderItem={({ item: section }) => (
          <View style={{ marginBottom: SPACING.lg }}>
            <Text style={styles.groupSectionLabel}>{section.label}</Text>
            <View style={styles.groupContainer}>
              {section.items.map((item, idx) => (
                <Swipeable
                  key={item.id}
                  renderRightActions={() => (
                    <View style={{ flexDirection: 'row' }}>
                      {item.sender_id !== userId && (
                        <Pressable
                          onPress={() => confirmBlock(item)}
                          style={[styles.swipeDeleteAction, { backgroundColor: COLORS.surfaceRaised, width: 92 }]}
                        >
                          <Ionicons name="ban-outline" size={20} color="#fff" />
                          <Text style={[styles.swipeDeleteText, { textAlign: 'center' }]}>Block sender</Text>
                        </Pressable>
                      )}
                      <Pressable onPress={() => handleHide(item)} style={styles.swipeDeleteAction}>
                        <Ionicons name="trash-outline" size={20} color="#fff" />
                        <Text style={styles.swipeDeleteText}>Delete</Text>
                      </Pressable>
                    </View>
                  )}
                >
                  <Pressable style={[styles.groupRow, idx > 0 && styles.groupRowDivider]} onPress={() => handleOpen(item)}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      {!item.opened_at && <View style={styles.unreadDot} />}
                      <Text style={[styles.groupRowTime, { flex: 1 }]} numberOfLines={1}>{item.senderName}</Text>
                      <Text style={styles.groupRowTime}>{formatRelativeTime(item.created_at)}</Text>
                    </View>
                    <Text style={[styles.savedCardTitle, { marginTop: 4, marginBottom: 2 }]} numberOfLines={1}>{item.concept.title}</Text>
                    {!!item.question && <Text style={styles.shareRowQuestion} numberOfLines={1}>{item.question}</Text>}
                    {!!item.note && <Text style={styles.shareRowNote} numberOfLines={1}>“{item.note}”</Text>}
                  </Pressable>
                </Swipeable>
              ))}
            </View>
          </View>
        )}
        ListEmptyComponent={
          <LibraryEmpty
            loading={loading}
            errorMsg={errorMsg}
            searchActive={q.length > 0}
            hasAny={items.length > 0}
            icon="mail-open-outline"
            text="Nothing shared with you yet."
          />
        }
      />
      <UndoToast visible={!!pendingDelete} label="Removed from your inbox" onUndo={() => undo(() => loadInbox(true))} />
    </View>
  );
}

// segment/setSegment, conceptFilter/setConceptFilter live in App() so other screens can jump
// to a segment (e.g. a card's "See all" conversations) and so the choice is remembered.
function LibraryScreen({ focused, segment, setSegment, conceptFilter, setConceptFilter, onSelectCard, onOpenShared, onOpenPlan }) {
  const { unreadShares } = useContext(UserContext);
  const [query, setQuery] = useState('');
  const [notesSort, setNotesSort] = useState('recent');
  const [savedSort, setSavedSort] = useState('recent');
  const [convFilter, setConvFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(false);

  const onScroll = useCallback((e) => {
    const next = e.nativeEvent.contentOffset.y > 40;
    setCollapsed((prev) => (prev === next ? prev : next));
  }, []);

  const changeSegment = (key) => {
    setSegment(key);
    setQuery('');
    setCollapsed(false);
    if (key !== 'conversations') setConceptFilter(null);
  };

  let action;
  if (segment === 'notes') action = { icon: 'swap-vertical-outline', items: SORT_OPTIONS, selectedKey: notesSort, onSelect: setNotesSort };
  else if (segment === 'saved') action = { icon: 'swap-vertical-outline', items: SORT_OPTIONS, selectedKey: savedSort, onSelect: setSavedSort };
  else if (segment === 'conversations') action = { icon: 'funnel-outline', items: CONVERSATION_FILTERS, selectedKey: convFilter, onSelect: setConvFilter };

  const placeholders = { notes: 'Search notes', saved: 'Search saved', conversations: 'Search conversations', shared: 'Search shared' };

  const header = (
    <View>
      <ScreenTitleBlock title="Library" />
      <SegmentedControl
        options={LIBRARY_SEGMENTS.map((s) => ({ ...s, dot: s.key === 'shared' && unreadShares > 0 }))}
        value={segment}
        onChange={changeSegment}
      />
      <SearchField value={query} onChangeText={setQuery} placeholder={placeholders[segment]} />
      {segment === 'conversations' && !!conceptFilter && (
        <Pressable onPress={() => setConceptFilter(null)} style={pressableStyle(styles.libraryFilterChip)}>
          <Text style={styles.libraryFilterChipText}>Showing one card's conversations</Text>
          <Ionicons name="close-circle" size={16} color={COLORS.textTertiary} />
        </Pressable>
      )}
    </View>
  );

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <ScreenHeader title="Library" collapsed={collapsed} action={action} compact />
      {segment === 'notes' && (
        <NotesList key="notes" query={query} sortKey={notesSort} header={header} onScroll={onScroll} onSelectCard={onSelectCard} focused={focused} />
      )}
      {segment === 'saved' && (
        <SavedList key="saved" query={query} sortKey={savedSort} header={header} onScroll={onScroll} onSelectCard={onSelectCard} focused={focused} />
      )}
      {segment === 'conversations' && (
        <ConversationsList key="conversations" query={query} activeFilter={convFilter} filterConceptId={conceptFilter} header={header} onScroll={onScroll} focused={focused} onSelectCard={onSelectCard} onOpenPlan={onOpenPlan} />
      )}
      {segment === 'shared' && (
        <SharedList key="shared" query={query} header={header} onScroll={onScroll} onOpenShared={onOpenShared} focused={focused} />
      )}
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------------------
// PROFILE
// ---------------------------------------------------------------------------------------
function InterestRows({ rows }) {
  return (
    <View style={styles.groupContainer}>
      {rows.map((s, idx) => (
        <View key={s.key} style={[styles.groupRow, styles.interestRow, idx > 0 && styles.groupRowDivider]}>
          <View style={[styles.categoryDot, { backgroundColor: CATEGORY_COLORS[s.key] || COLORS.textTertiary }]} />
          <Text style={styles.interestName} numberOfLines={1}>{CATEGORY_LABELS[s.key] ?? s.key}</Text>
          <Text style={styles.interestCount}>{s.seen} seen</Text>
        </View>
      ))}
    </View>
  );
}

function ProfileScreen({ focused, onAccount }) {
  const { userId, authUser } = useContext(UserContext);
  const secured = !authUser.isAnonymous && !!authUser.email;
  const { stats } = useCategoryStats(userId, focused);
  const [profile, setProfile] = useState(undefined); // undefined = loading, null = none yet
  const [profileFailed, setProfileFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const { collapsed, onScroll } = useCollapsingTitle();

  const loadProfile = useCallback(async () => {
    const { profile: p, error } = await fetchMyProfile(userId);
    setProfileFailed(!!error);
    setProfile(error ? null : p);
  }, [userId]);
  useEffect(() => { loadProfile(); }, [loadProfile]);
  useRefetchOnFocus(focused, loadProfile);

  const mostSeen = [...stats].filter((s) => s.seen > 0).sort((a, b) => b.seen - a.seen || b.seen / b.total - a.seen / a.total).slice(0, 3);
  const leastSeen = [...stats].sort((a, b) => a.seen - b.seen || b.total - a.total).slice(0, 3);

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScreenHeader title="Profile" collapsed={collapsed} compact />
        <ScrollView contentContainerStyle={styles.tabListContent} onScroll={onScroll} scrollEventThrottle={16} keyboardShouldPersistTaps="handled">
          <ScreenTitleBlock title="Profile" />

          <Pressable style={pressableStyle([styles.gameHubCard, SHADOW])} onPress={onAccount}>
            <View style={[styles.gameHubIconWrap, { backgroundColor: 'rgba(184,134,11,0.15)' }]}>
              <Ionicons name="shield-checkmark-outline" size={26} color={COLORS.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.gameHubTitle}>{secured ? 'Account' : 'Secure your account'}</Text>
              <Text style={styles.gameHubDesc} numberOfLines={1}>
                {secured ? authUser.email : 'Add your email so you never lose your notes.'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={COLORS.textTertiary} />
          </Pressable>

          {profile !== undefined && !profileFailed && (
            <View style={[styles.gameHubCard, SHADOW]}>
              <View style={[styles.gameHubIconWrap, { backgroundColor: 'rgba(184,134,11,0.15)' }]}>
                <Ionicons name="person-circle-outline" size={28} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.gameHubTitle} numberOfLines={1}>{profile ? profile.display_name : 'Choose your handle'}</Text>
                <Text style={styles.gameHubDesc} numberOfLines={1}>
                  {profile ? `@${profile.handle}` : 'So friends can send you ideas.'}
                </Text>
              </View>
              <Pressable onPress={() => setEditing((e) => !e)} hitSlop={8} style={pressableStyle(styles.profileEditButton)} accessibilityRole="button" accessibilityLabel={profile ? 'Edit handle and name' : 'Choose a handle'}>
                <Text style={styles.secureLinkText}>{editing ? 'Cancel' : profile ? 'Edit' : 'Set up'}</Text>
              </Pressable>
            </View>
          )}
          {editing && (
            <View style={{ marginBottom: SPACING.md }}>
              <ProfileForm
                key={profile ? profile.handle : 'new'}
                userId={userId}
                initial={profile}
                submitLabel={profile ? 'Save profile' : 'Create profile'}
                onSaved={(p) => { setProfile(p); setEditing(false); }}
              />
            </View>
          )}

          <Text style={[styles.groupSectionLabel, { marginTop: SPACING.md }]}>YOUR INTERESTS</Text>
          {stats.length === 0 ? (
            <Text style={styles.emptyText}>Read a few cards and your interests will show up here.</Text>
          ) : (
            <View>
              {mostSeen.length > 0 && (
                <View style={{ marginBottom: SPACING.md }}>
                  <Text style={styles.interestSubLabel}>Most seen</Text>
                  <InterestRows rows={mostSeen} />
                </View>
              )}
              <View>
                <Text style={styles.interestSubLabel}>Least seen</Text>
                <InterestRows rows={leastSeen} />
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------------------
// TAB BAR: Home, Learn, Library, Games, Profile
// ---------------------------------------------------------------------------------------
const TAB_ITEMS = [
  { key: 'home', icon: 'home', iconOutline: 'home-outline' },
  { key: 'learn', icon: 'compass', iconOutline: 'compass-outline' },
  { key: 'library', icon: 'library', iconOutline: 'library-outline' },
  { key: 'games', icon: 'game-controller', iconOutline: 'game-controller-outline' },
  { key: 'profile', icon: 'person', iconOutline: 'person-outline' },
];

function TabBar({ active, onNavigate, libraryDot }) {
  const itemWidth = Math.floor(Math.min(72, (width - 44) / TAB_ITEMS.length));
  return (
    <View style={styles.tabBarWrap} pointerEvents="box-none">
      <BlurView intensity={60} tint="dark" style={styles.tabBar}>
        {TAB_ITEMS.map((tab) => {
          const isActive = active === tab.key;
          const color = isActive ? COLORS.primary : 'rgba(255,255,255,0.6)';
          const showDot = tab.key === 'library' && libraryDot;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onNavigate(tab.key)}
              style={[styles.tabItem, { width: itemWidth }]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={showDot ? `${TAB_LABELS[tab.key]}, new shared items` : TAB_LABELS[tab.key]}
            >
              <View>
                <Ionicons name={isActive ? tab.icon : tab.iconOutline} size={22} color={color} />
                {showDot && <View style={styles.tabDot} />}
              </View>
              <Text style={[styles.tabLabel, { color }]} numberOfLines={1}>{TAB_LABELS[tab.key]}</Text>
            </Pressable>
          );
        })}
      </BlurView>
    </View>
  );
}

// =====================================================================================
// PREPARE: who are you seeing, and where -> three ideas from the library to talk about.
// Served by the ask-agora function (mode 'prepare'); each plan is saved to conversation_plans
// automatically and also appears in Library > Conversations as "Prepared".
// =====================================================================================
const PREPARE_OCCASIONS = ['Dinner', 'Walk or hike', 'Coffee', 'Long drive', 'Date', 'Work'];
const PREPARE_WHO_MAX = 200;

// Plans as Library rows: shaped like conversations (kind + updated_at) so they sort and group with them.
async function fetchPlans(userId) {
  if (!userId) return { plans: [] };
  const { data, error } = await supabase
    .from('conversation_plans')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) return { error };
  return { plans: (data || []).map((p) => ({ ...p, kind: 'plan', mode: 'prepare', updated_at: p.created_at })) };
}

async function deletePlanRow(id) {
  const { error } = await supabase.from('conversation_plans').delete().eq('id', id);
  return { ok: !error, error };
}

// plan: an existing conversation_plans row (reopened from the Library), or undefined for a new one.
function PrepareScreen({ plan, onBack, backLabel, onOpenCard }) {
  const [who, setWho] = useState(plan ? plan.who : '');
  const [occasion, setOccasion] = useState(plan ? plan.occasion : null);
  const [phase, setPhase] = useState(plan ? 'result' : 'form'); // form | loading | result
  const [items, setItems] = useState(plan ? plan.items || [] : []);
  const [concepts, setConcepts] = useState({}); // id -> { id, title, category }
  const [planId, setPlanId] = useState(plan ? plan.id : null);
  const [shownIds, setShownIds] = useState(plan ? (plan.items || []).map((i) => String(i.concept_id)) : []);
  const [errorMsg, setErrorMsg] = useState(null);
  const [limitReached, setLimitReached] = useState(null);
  const [rerolling, setRerolling] = useState(false);

  const canPrepare = who.trim().length > 0 && !!occasion;

  // Card titles and categories for the picks.
  useEffect(() => {
    const ids = items.map((i) => i.concept_id);
    if (ids.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('concepts').select('id, title, category').in('id', ids);
      if (cancelled || !data) return;
      setConcepts(Object.fromEntries(data.map((c) => [String(c.id), c])));
    })();
    return () => { cancelled = true; };
  }, [items]);

  // reroll: ask again for three OTHER cards (the ones already shown are excluded) and update this plan.
  const ask = async (reroll) => {
    setErrorMsg(null);
    setLimitReached(null);
    if (reroll) setRerolling(true);
    else setPhase('loading');
    try {
      const { data, error } = await supabase.functions.invoke(ASK_AGORA_FUNCTION_SLUG, {
        body: {
          mode: 'prepare',
          who: who.trim(),
          occasion,
          exclude_ids: reroll ? shownIds : undefined,
          plan_id: reroll && planId ? planId : undefined,
        },
      });
      if (error) throw error;
      if (data.limit_reached) {
        setLimitReached(data.message);
        if (!reroll) setPhase('form');
        return;
      }
      setItems(data.picks);
      setPlanId(data.plan_id || null);
      setShownIds((prev) => [...prev, ...data.picks.map((p) => String(p.concept_id))]);
      setPhase('result');
    } catch (e) {
      const detail = await describeInvokeError(e);
      setErrorMsg(`Couldn't prepare that: ${detail}`);
      if (!reroll) setPhase('form');
    } finally {
      setRerolling(false);
    }
  };

  const shownCards = items.filter((i) => concepts[String(i.concept_id)]);

  return (
    <LinearGradient colors={['#0E0F12', '#0E0F12', '#1D1F24']} locations={[0, 0.85, 1]} style={{ flex: 1 }}>
      <ScreenHeader title="Prepare" backLabel={backLabel} onBack={onBack} collapsed={false} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.screenListContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {phase === 'form' && (
            <View>
              <ScreenTitleBlock title="Prepare" />
              <Text style={styles.groupSectionLabel}>Who are you seeing?</Text>
              <TextInput
                style={[styles.secureInput, { marginBottom: SPACING.xs }]}
                value={who}
                onChangeText={(t) => { setWho(t); setErrorMsg(null); }}
                placeholder="My sister"
                placeholderTextColor={COLORS.textMuted}
                maxLength={PREPARE_WHO_MAX}
                returnKeyType="done"
              />
              <View style={styles.prepareHintRow}>
                <Text style={styles.prepareHint}>A first name or a role is enough — e.g. my sister, a new client.</Text>
                <Text style={styles.prepareHint}>{who.length}/{PREPARE_WHO_MAX}</Text>
              </View>

              <Text style={[styles.groupSectionLabel, { marginTop: SPACING.md }]}>Where?</Text>
              <View style={styles.prepareChipRow}>
                {PREPARE_OCCASIONS.map((o) => {
                  const selected = occasion === o;
                  return (
                    <Pressable
                      key={o}
                      onPress={() => setOccasion(o)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={pressableStyle([styles.prepareChip, selected && styles.prepareChipSelected])}
                    >
                      <Text style={[styles.prepareChipText, selected && styles.prepareChipTextSelected]}>{o}</Text>
                    </Pressable>
                  );
                })}
              </View>

              {!!limitReached && <Text style={styles.askLimitText}>{limitReached}</Text>}
              {!!errorMsg && <Text style={styles.askErrorText}>{errorMsg}</Text>}
              <Pressable
                style={pressableStyle([styles.primaryButton, { marginTop: SPACING.lg }, !canPrepare && { opacity: 0.4 }])}
                onPress={() => ask(false)}
                disabled={!canPrepare}
              >
                <Text style={styles.primaryButtonText}>Prepare</Text>
              </Pressable>
            </View>
          )}

          {phase === 'loading' && (
            <View>
              <ScreenTitleBlock title="Prepare" />
              <View style={{ alignItems: 'center', paddingVertical: SPACING.xxl }}>
                <ActivityIndicator color={COLORS.primary} size="large" />
                <Text style={[styles.explainTip, { marginTop: SPACING.md }]}>Choosing ideas for {who.trim()}…</Text>
              </View>
            </View>
          )}

          {phase === 'result' && (
            <View>
              <Text style={styles.prepareHeading}>Ideas for {who}</Text>
              <Text style={styles.prepareSub}>{occasion}</Text>

              {shownCards.length === 0 ? (
                <ActivityIndicator color={COLORS.primary} style={{ marginVertical: SPACING.xl }} />
              ) : (
                shownCards.map((it) => {
                  const c = concepts[String(it.concept_id)];
                  const catColor = CATEGORY_COLORS[c.category] || COLORS.textTertiary;
                  return (
                    <Pressable
                      key={String(it.concept_id)}
                      style={pressableStyle(styles.prepareCard)}
                      onPress={() => onOpenCard(c.id, shownCards.map((s) => concepts[String(s.concept_id)].id))}
                    >
                      <View style={styles.categoryRow}>
                        <View style={[styles.categoryDot, { backgroundColor: catColor }]} />
                        <Text style={[styles.category, { color: catColor }]}>{CATEGORY_LABELS[c.category] ?? c.category}</Text>
                      </View>
                      <Text style={styles.prepareCardTitle}>{c.title}</Text>
                      <Text style={styles.prepareWhy}>{it.why}</Text>
                      <Text style={styles.prepareOpener}>“{it.opener}”</Text>
                      <Text style={styles.prepareFollowUp}>{it.follow_up}</Text>
                    </Pressable>
                  );
                })
              )}

              {!!limitReached && <Text style={styles.askLimitText}>{limitReached}</Text>}
              {!!errorMsg && <Text style={styles.askErrorText}>{errorMsg}</Text>}
              <Pressable
                style={pressableStyle([styles.askSecondaryButton, rerolling && { opacity: 0.6 }])}
                onPress={() => ask(true)}
                disabled={rerolling}
              >
                {rerolling ? <ActivityIndicator color={COLORS.textPrimary} /> : <Text style={styles.askSecondaryButtonText}>Try three others</Text>}
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

// =====================================================================================
// "Install Kepos" banner — web only (App() renders it only when Platform.OS === 'web').
// iPhone/iPad Safari can't show a real install prompt, so it explains Share > Add to Home Screen
// with an arrow pointing down toward Safari's share button; Chrome/Android get the browser's real
// install prompt. Shown once (dismissal is remembered), and never when the app is already running
// from the home screen.
// =====================================================================================
const INSTALL_BANNER_DISMISSED_KEY = 'kepos_install_banner_dismissed';

function rememberInstallBannerDismissed() {
  try { window.localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, '1'); } catch (e) { /* private mode etc. */ }
}

function isRunningFromHomeScreen() {
  try {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  } catch (e) {
    return false;
  }
}

function isIosBrowser() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function InstallBanner() {
  const [mode, setMode] = useState(null); // null | 'ios' | 'prompt'
  const promptRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === '1'; } catch (e) { /* ignore */ }
    if (dismissed || isRunningFromHomeScreen()) return undefined;
    const onBeforeInstall = (e) => {
      e.preventDefault(); // hold the browser's prompt until the person taps Install
      promptRef.current = e;
      setMode('prompt');
    };
    const onInstalled = () => { rememberInstallBannerDismissed(); setMode(null); };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    if (isIosBrowser()) setMode('ios');
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => { rememberInstallBannerDismissed(); setMode(null); };
  const install = async () => {
    const deferred = promptRef.current;
    if (!deferred) return;
    try {
      deferred.prompt();
      await deferred.userChoice;
    } catch (e) { /* ignore */ }
    promptRef.current = null;
    rememberInstallBannerDismissed();
    setMode(null);
  };

  if (!mode) return null;
  return (
    <View style={styles.installBanner} accessibilityRole="alert">
      <View style={styles.installBannerRow}>
        <Ionicons name={mode === 'ios' ? 'share-outline' : 'download-outline'} size={22} color={COLORS.primary} />
        <Text style={styles.installBannerText}>
          {mode === 'ios'
            ? `Install ${APP_NAME}: tap Share, then Add to Home Screen`
            : `Install ${APP_NAME} on your home screen`}
        </Text>
        {mode === 'prompt' && (
          <Pressable onPress={install} style={pressableStyle(styles.installBannerButton)} accessibilityRole="button" accessibilityLabel={`Install ${APP_NAME}`}>
            <Text style={styles.installBannerButtonText}>Install</Text>
          </Pressable>
        )}
        <Pressable onPress={dismiss} style={pressableStyle(styles.installBannerClose)} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Ionicons name="close" size={20} color={COLORS.textTertiary} />
        </Pressable>
      </View>
      {mode === 'ios' && (
        <View style={styles.installBannerArrow}>
          <Ionicons name="arrow-down" size={20} color={COLORS.primary} />
        </View>
      )}
    </View>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Cinzel_700Bold,
    Cinzel_600SemiBold,
    Inter_400Regular,
    Inter_600SemiBold,
  });

  useEffect(() => {
    if (Platform.OS !== 'web') setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  // Navigation: one of five tabs, plus a stack of pushed full-screen views (card, feed, a game,
  // account...). Each stack entry is { name, params }. While the stack is empty the tab bar is
  // shown; tab screens stay mounted underneath pushed views, so Back returns to the same tab
  // at the same scroll position.
  const [tab, setTab] = useState('home');
  const [visited, setVisited] = useState({ home: true });
  const [stack, setStack] = useState([]);
  // Library: the selected segment is remembered while the app is open; the concept filter is set
  // when a card's "See all" opens Conversations scoped to that one card.
  const [librarySegment, setLibrarySegment] = useState('notes');
  const [libraryConceptFilter, setLibraryConceptFilter] = useState(null);
  // Unread "Shared with you" items — drives the dots on the Library tab and the Shared segment.
  const [unreadShares, setUnreadShares] = useState(0);

  // Anonymous sign-in: invisible to the user, no login screen. userId stays null if this
  // fails (e.g. offline) — cards still render either way (their read doesn't require auth),
  // and anything user-specific just no-ops until a session shows up. onAuthStateChange also
  // catches the session hydrating from AsyncStorage on a cold start.
  const [userId, setUserId] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  // Surfaced as an on-screen banner below (Snack's own console can be hard to find), so a
  // sign-in problem is visible directly in the app instead of only in a log you'd have to hunt for.
  const [authError, setAuthError] = useState(null);

  // Whether the current user has attached an email, and a counter that bumps whenever the user
  // id changes (sign in on a new device, sign out) so every screen remounts and reloads.
  const [authUser, setAuthUser] = useState({ email: null, isAnonymous: true });
  const [dataEpoch, setDataEpoch] = useState(0);
  // Brief confirmation toast ("Your account is secured") shown over whichever screen is next.
  const [notice, setNotice] = useState(null);
  const lastUserIdRef = useRef(null);
  const sessionPromiseRef = useRef(null);

  // The one place a session becomes app state. If the user id differs from the previous one,
  // everything cached for the old user is thrown away first.
  const applySession = useCallback((session) => {
    const user = session && session.user;
    if (!user) return;
    if (lastUserIdRef.current && lastUserIdRef.current !== user.id) {
      clearUserCaches();
      setDataEpoch((e) => e + 1);
    }
    lastUserIdRef.current = user.id;
    setUserId(user.id);
    setAuthUser({ email: user.email || null, isAnonymous: !!user.is_anonymous });
  }, []);

  // Uses the persisted session if there is one, otherwise signs in anonymously (first launch,
  // and after sign-out). Concurrent callers share one in-flight attempt so we never create two
  // anonymous users.
  const ensureSession = useCallback(() => {
    if (sessionPromiseRef.current) return sessionPromiseRef.current;
    const p = (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session && session.user) {
        applySession(session);
        return {};
      }
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) return { error };
      if (data && data.session) applySession(data.session);
      return {};
    })().finally(() => { sessionPromiseRef.current = null; });
    sessionPromiseRef.current = p;
    return p;
  }, [applySession]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { error } = await ensureSession();
        if (error) {
          console.error('Anonymous sign-in failed', error);
          if (mounted) setAuthError(error.message || JSON.stringify(error));
        }
      } catch (e) {
        console.error('Auth init failed', e);
        if (mounted) setAuthError(e && e.message ? e.message : String(e));
      } finally {
        if (mounted) setAuthReady(true);
      }
    })();

    // Keep the callback synchronous (supabase-js docs warn against awaiting other auth calls
    // inside it); anything that needs a network call is deferred with setTimeout.
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && session.user) {
        applySession(session);
      } else if (event === 'SIGNED_OUT') {
        // Signed out (by us, or the session became unrecoverable): forget the old user, then
        // start a fresh anonymous session so the app is never left without one.
        lastUserIdRef.current = null;
        clearUserCaches();
        setDataEpoch((e) => e + 1);
        setUserId(null);
        setAuthUser({ email: null, isAnonymous: true });
        setTimeout(() => {
          ensureSession().then(({ error }) => {
            if (error && mounted) setAuthError(error.message || JSON.stringify(error));
          }).catch(() => {});
        }, 0);
      }
    });

    return () => {
      mounted = false;
      authListener?.subscription?.unsubscribe?.();
    };
  }, [applySession, ensureSession]);

  // 'local' scope: only this phone is signed out; other devices on the secured account stay
  // signed in.
  const signOutAndReset = useCallback(async () => {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) return { error };
    return ensureSession();
  }, [ensureSession]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 2800);
    return () => clearTimeout(t);
  }, [notice]);

  // Kick off (and cache) the activity/notes loads as soon as a user exists, so screens that
  // need them typically find them already warm instead of each triggering its own fetch.
  useEffect(() => {
    if (userId) {
      ensureActivityLoaded(userId);
      ensureNotesLoaded(userId);
    }
  }, [userId]);

  // A different signed-in user (sign in / sign out): every screen has just been remounted by
  // key={dataEpoch}; also drop any pushed views and land on Profile, as before.
  useEffect(() => {
    if (dataEpoch > 0) {
      setStack([]);
      setTab('profile');
      setVisited({ profile: true });
    }
  }, [dataEpoch]);

  // Unread "Shared with you" count for the Library dots; refreshed when the visible screen
  // changes and when the app returns to the foreground.
  const refreshUnread = useCallback(async () => {
    if (!userId) { setUnreadShares(0); return; }
    const n = await fetchUnreadShareCount(userId);
    if (n != null) setUnreadShares(n);
  }, [userId]);
  useEffect(() => { refreshUnread(); }, [refreshUnread, tab, stack.length]);
  useRefreshOnForeground(refreshUnread);

  if (!fontsLoaded) {
    return (
      <RootSafeArea style={{ flex: 1, backgroundColor: '#0E0F12', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color="#B8860B" size="large" />
      </RootSafeArea>
    );
  }

  const stackEmpty = stack.length === 0;
  const push = (name, params = {}) => setStack((s) => [...s, { name, params }]);
  const pop = () => setStack((s) => s.slice(0, -1));
  const goTab = (key) => {
    setVisited((v) => (v[key] ? v : { ...v, [key]: true }));
    setStack([]);
    setTab(key);
  };

  // ids: the ordered list of cards to page through from here — defaults to just this
  // one card when the caller has no surrounding list.
  const openCard = (id, ids = null) => {
    push('cardDetail', { ids: ids && ids.length ? ids : [id], initialId: id, banner: null });
  };

  // Opens a card that someone shared, with the "<name> asked: <question>" banner above it.
  // share: { concept_id, senderName, question, note }. Used by Home, the Library's Shared
  // segment and openShareByCode.
  const openSharedCard = (share) => {
    push('cardDetail', {
      ids: [share.concept_id],
      initialId: share.concept_id,
      banner: { senderName: share.senderName, question: share.question, note: share.note },
    });
  };

  // Loads a share by its code (via the get_share_by_code database function) and opens its card
  // with the same banner as the inbox. Returns { ok: false } if the code isn't found.
  //
  // NOT WIRED TO ANYTHING YET. When share links go live (SHARE_LINKS_ENABLED = true), the link
  // handler belongs here at launch: read the URL from Linking.getInitialURL() (cold start) and
  // Linking.addEventListener('url', ...) (already running), match `${SHARE_BASE_URL}/s/<code>`,
  // and call openShareByCode(code) — once authReady is true, since the lookup needs a session.
  // It is also exposed on NavContext so any component can call it.
  const openShareByCode = async (code) => {
    try {
      const { data, error } = await supabase.rpc('get_share_by_code', { p_code: String(code || '').trim() });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) return { ok: false };
      if (row.channel === 'in_app') markShareOpened(row.id);
      openSharedCard({
        concept_id: row.concept_id,
        senderName: row.sender_id === userId ? 'You' : row.sender_display_name || 'Someone',
        question: row.question,
        note: row.note,
      });
      return { ok: true };
    } catch (e) {
      console.error('openShareByCode failed', e);
      return { ok: false };
    }
  };

  // A card's "See all" conversations: jump to Library > Conversations, filtered to that card.
  const openConversationsForConcept = (conceptId) => {
    setLibraryConceptFilter(conceptId);
    setLibrarySegment('conversations');
    goTab('library');
  };

  const openGame = (key) => {
    const names = { quiz: 'quiz', crossword: 'crossword', truthLie: 'truthLie', emoji: 'emoji', quizHistory: 'quizHistory' };
    push(names[key]);
  };

  // "Back" label: the tab you came from, or a plain "Back" when stacked on another pushed view.
  const renderEntry = (entry, index) => {
    const backLabel = index > 0 ? 'Back' : TAB_LABELS[tab];
    switch (entry.name) {
      case 'feed':
        return <FeedScreen category={entry.params.category} onBack={pop} backLabel={backLabel} />;
      case 'dailyThree':
        return <DailyThreeScreen onBack={pop} backLabel={backLabel} />;
      case 'quiz':
        return <QuizScreen onBack={pop} backLabel={backLabel} />;
      case 'quizHistory':
        return <QuizHistoryScreen onBack={pop} backLabel={backLabel} />;
      case 'crossword':
        return <CrosswordScreen onBack={pop} backLabel={backLabel} />;
      case 'truthLie':
        return <TruthLieGameScreen onBack={pop} backLabel={backLabel} />;
      case 'emoji':
        return <EmojiRiddleGameScreen onBack={pop} backLabel={backLabel} />;
      case 'cardDetail':
        return (
          <CardDetailScreen
            conceptIds={entry.params.ids}
            initialId={entry.params.initialId}
            onBack={pop}
            backLabel={backLabel}
            banner={entry.params.banner}
          />
        );
      case 'secure':
        return <SecureAccountScreen onBack={pop} onDone={(message) => { setNotice(message); pop(); }} />;
      case 'prepare':
        return <PrepareScreen plan={entry.params.plan} onBack={pop} backLabel={backLabel} onOpenCard={(id, ids) => openCard(id, ids)} />;
      case 'account':
        return <AccountScreen onBack={pop} onDone={(message) => { setNotice(message); pop(); }} />;
      default:
        return null;
    }
  };

  const paneStyle = (visible) => [styles.tabPane, !visible && styles.tabPaneHidden];

  return (
    <SafeAreaProvider>
    <GestureHandlerRootView style={Platform.OS === 'web' ? { flex: 1, maxWidth: WEB_MAX_WIDTH, marginLeft: 'auto', marginRight: 'auto', backgroundColor: '#0E0F12' } : { flex: 1 }}>
    <UserContext.Provider value={{ userId, authReady, authUser, signOutAndReset, unreadShares }}>
    <NavContext.Provider value={{ openConversationsForConcept, openShareByCode }}>
      <RootSafeArea style={{ flex: 1, backgroundColor: '#0E0F12' }}>
      {authError && (
        <View style={styles.authErrorBanner} pointerEvents="none">
          <Text style={styles.authErrorText} numberOfLines={3}>Sign-in issue: {authError}</Text>
        </View>
      )}
      {/* key={dataEpoch}: a different signed-in user remounts every screen so it reloads. */}
      <View style={{ flex: 1 }} key={dataEpoch}>
        {visited.home && (
          <View style={paneStyle(tab === 'home' && stackEmpty)}>
            <HomeScreen
              focused={tab === 'home' && stackEmpty}
              onOpenCard={(id, ids) => openCard(id, ids)}
              onOpenDailyThree={() => push('dailyThree')}
              onOpenShared={openSharedCard}
              onOpenPrepare={() => push('prepare')}
            />
          </View>
        )}
        {visited.learn && (
          <View style={paneStyle(tab === 'learn' && stackEmpty)}>
            <LearnScreen
              focused={tab === 'learn' && stackEmpty}
              onOpenFeed={(cat) => push('feed', { category: cat })}
              onSelectCard={(id, ids) => openCard(id, ids)}
            />
          </View>
        )}
        {visited.library && (
          <View style={paneStyle(tab === 'library' && stackEmpty)}>
            <LibraryScreen
              focused={tab === 'library' && stackEmpty}
              segment={librarySegment}
              setSegment={setLibrarySegment}
              conceptFilter={libraryConceptFilter}
              setConceptFilter={setLibraryConceptFilter}
              onSelectCard={(id, ids) => openCard(id, ids)}
              onOpenShared={openSharedCard}
              onOpenPlan={(plan) => push('prepare', { plan })}
            />
          </View>
        )}
        {visited.games && (
          <View style={paneStyle(tab === 'games' && stackEmpty)}>
            <GamesScreen focused={tab === 'games' && stackEmpty} onOpen={openGame} onOpenCard={(id) => openCard(id)} />
          </View>
        )}
        {visited.profile && (
          <View style={paneStyle(tab === 'profile' && stackEmpty)}>
            <ProfileScreen
              focused={tab === 'profile' && stackEmpty}
              onAccount={() => push(!authUser.isAnonymous && authUser.email ? 'account' : 'secure')}
            />
          </View>
        )}
        {stack.map((entry, i) => (
          <View key={`${i}-${entry.name}`} style={paneStyle(i === stack.length - 1)}>
            <ScreenTransition>{renderEntry(entry, i)}</ScreenTransition>
          </View>
        ))}
      </View>
      {notice && (
        <View style={[styles.undoToast, { justifyContent: 'center' }]} pointerEvents="none">
          <Text style={styles.undoToastText}>{notice}</Text>
        </View>
      )}
      {Platform.OS === 'web' && <InstallBanner />}
      {stackEmpty && <TabBar active={tab} onNavigate={goTab} libraryDot={unreadShares > 0} />}
    </RootSafeArea>
    </NavContext.Provider>
    </UserContext.Provider>
    </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  // Card (reading screen)
    // Colourless, liquid-glass look — same BlurView technique as the TabBar pill — instead of
    // a flat tinted fill, so these read as neutral glass rather than a bronze chip.
  card: { height: CARD_HEIGHT, backgroundColor: COLORS.bg, overflow: 'hidden' },
  cardPageContent: { flex: 1, paddingHorizontal: 28, paddingTop: 4 },
  cardFixedHeader: { paddingHorizontal: 28, paddingTop: SPACING.lg, paddingBottom: 22 },
  category: { textTransform: 'uppercase', letterSpacing: 2, fontSize: TYPE.micro, fontWeight: '700' },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 18 },
  categoryDot: { width: 8, height: 8, borderRadius: 4 },

  title: { color: COLORS.textPrimary, fontSize: 26, fontFamily: 'Cinzel_600SemiBold', marginBottom: -5, lineHeight: 32 },
hook: { color: 'rgba(255,255,255,0.85)', fontSize: 18, lineHeight: 26.01, marginBottom: 24, paddingBottom: 1, width: CARD_CONTENT_WIDTH },


   explanation: {
  color: 'rgba(255,255,255,0.75)',
  fontSize: 16,
  lineHeight: 24.01,
  marginBottom: 20,
  paddingBottom: 1,
  width: CARD_CONTENT_WIDTH,
},

  angleLabel: { color: COLORS.textTertiary, fontSize: TYPE.micro, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },

  pageHeading: { color: COLORS.textTertiary, fontSize: TYPE.micro, textTransform: 'uppercase', letterSpacing: 2, fontWeight: '700', marginBottom: 16 },
  angleLarge: { color: 'rgba(255,255,255,0.85)', paddingBottom: 1,fontSize: 16, lineHeight: 24.01, fontStyle: 'italic'},
  exampleLarge: { color: 'rgba(255,255,255,0.85)', paddingBottom: 1, fontSize: 16, lineHeight: 24.01, fontStyle: 'italic', marginBottom: 20 },
   discussionTextLarge: { color: 'rgba(255,255,255,0.85)', paddingBottom: 1,fontSize: 16, lineHeight: 24.01, fontStyle: 'italic', marginBottom: 20 },
  cardActionRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: SPACING.md, paddingBottom: 12 },
  cardActionButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pageDots: { position: 'absolute', bottom: 64, alignSelf: 'center', flexDirection: 'row', gap: 6 },
    pageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  pageDotActive: { backgroundColor: COLORS.primary, width: 18 },

  // Shared layout
  center: { flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center', alignItems: 'center', padding: SPACING.xl },
  emptyText: { color: COLORS.textTertiary, textAlign: 'center', fontSize: TYPE.body, lineHeight: 22, marginTop: 8 },
  backButton: { position: 'absolute', top: 52, left: 20, zIndex: 10 },
  backButtonText: { color: COLORS.primary, fontSize: 16, fontWeight: '600' },

  // Home screen
  // marginBottom lifts the mark past the tagline's own bottom margin (SPACING.sm) so the frame's bottom stroke
  // lines up with the tagline; marginRight is slightly negative to cancel the PNG's transparent edge so
  // the right stroke lines up with the right edge of the cards below. Nudge these two if it is off.
  headerIcon: { width: HOME_MARK_HEIGHT * KEPOS_MARK_ASPECT, height: HOME_MARK_HEIGHT, marginRight: -1.5, marginBottom: 6.5, flexShrink: 0 },
  wordmarkGroup: { flexDirection: 'row', alignItems: 'flex-end', gap: 0 },
  wordmarkMeasure: { position: 'absolute', left: 0, top: 0, opacity: 0 },
wordmarkSuffix: { color: COLORS.primary, fontFamily: 'Inter_600SemiBold', fontSize: 20, marginBottom: 4 },
  homeContainer: { padding: SPACING.lg, paddingTop: SPACING.xl, paddingBottom: 140 },
    heroRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: SPACING.xs,  },
homeTitle: { color: COLORS.textPrimary, fontSize: TYPE.hero, fontFamily: 'Cinzel_700Bold', letterSpacing: 0, marginBottom: SPACING.xxs },
  homeSubtitle: { color: COLORS.textPrimary, fontSize: TYPE.body, fontWeight: '600', marginBottom: SPACING.sm, lineHeight: 22, letterSpacing: 0.2 },
    todayRow: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.md },
    todayCard: { flex: 1, borderRadius: RADIUS.md, paddingVertical: SPACING.md, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  todayCardIcon: { marginBottom: SPACING.sm },
gamesButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: RADIUS.md, paddingVertical: 8, marginBottom: SPACING.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  gamesButtonText: { color: COLORS.textPrimary, fontSize: TYPE.caption, fontWeight: '700' },
  todayCardTitle: { color: COLORS.textPrimary, fontSize: TYPE.caption, fontWeight: '700' },
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingVertical: SPACING.md, marginBottom: SPACING.md },
primaryButtonText: { color: COLORS.primaryText, fontSize: TYPE.subtitle, fontWeight: '700' },
categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.xs },
categoryTile: { width: '48%', borderRadius: RADIUS.md, paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
    categoryTileText: { color: COLORS.textPrimary, fontSize: TYPE.body, fontWeight: '600', textAlign: 'center' },
    secondaryRow: { flexDirection: 'row', gap: SPACING.md, justifyContent: 'center' },
  secondaryLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: SPACING.sm },
  secondaryLinkText: { color: COLORS.textTertiary, fontSize: TYPE.caption, fontWeight: '600' },
  browseHeader: { paddingHorizontal: 28, paddingTop: SPACING.xl, paddingBottom: 16 },
    searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', marginTop: 12 },
  searchInput: { flex: 1, color: COLORS.textPrimary, fontSize: TYPE.body, paddingVertical: 4 },
  browseListContent: { paddingHorizontal: 28, paddingBottom: 60 },
    browseRow: { flexDirection: 'row', alignItems: 'center', borderRadius: RADIUS.md, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  browseRowTitle: { color: COLORS.textPrimary, fontSize: TYPE.body, fontWeight: '600', marginBottom: 2 },
  browseRowHook: { color: COLORS.textTertiary, fontSize: TYPE.caption },

  // Saved screen
  savedCard: { borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', padding: SPACING.md, marginBottom: SPACING.sm },
  savedCardCategoryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  savedCardTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_600SemiBold', fontSize: TYPE.subtitle, marginBottom: 4 },
  savedCardHook: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18 },
  filterRow: { marginBottom: SPACING.md },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 8, paddingHorizontal: 14, marginRight: SPACING.sm },
  filterChipActive: { backgroundColor: COLORS.surfaceRaised },
  filterChipDot: { width: 8, height: 8, borderRadius: 4 },
  filterChipText: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: '600' },
  filterChipTextActive: { color: COLORS.textPrimary },

  // My Notes screen
  // Its own card style (not reused from Saved) — a note row carries one more line of real
  // content than a Saved row, so it gets more room to breathe: bigger radius, more padding,
  // metadata moved into the header line instead of crammed underneath, and a higher-contrast,
  // larger preview since the note's own words are the point of this screen.
  // Grouped-list sections shared by My Notes and Conversations (A2/B4): one outline container
  // per section with hairline dividers between rows, inset-grouped-list style.
  groupSectionLabel: { color: COLORS.textTertiary, fontSize: TYPE.micro, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '700', marginBottom: 8 },
  groupContainer: { borderRadius: RADIUS.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  groupRow: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, backgroundColor: COLORS.bg },
  groupRowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.14)' },
  groupRowMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  groupRowTime: { color: COLORS.textSecondary, fontSize: TYPE.micro, fontWeight: '600' },
  groupRowPreview: { flex: 1, color: COLORS.textTertiary, fontSize: TYPE.caption },
  debriefBadgeText: { color: COLORS.primary, fontSize: TYPE.micro, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },

  // Swipe-to-delete action + undo toast, shared by My Notes and Conversations.
  swipeDeleteAction: { backgroundColor: COLORS.danger, justifyContent: 'center', alignItems: 'center', width: 84, gap: 2 },
  swipeDeleteText: { color: '#fff', fontSize: TYPE.micro, fontWeight: '700' },
  undoToast: { position: 'absolute', bottom: 110, left: 24, right: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: COLORS.surfaceRaised, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 12, paddingHorizontal: 16 },
  undoToastText: { color: COLORS.textPrimary, fontSize: TYPE.caption },
  undoToastAction: { color: COLORS.primary, fontSize: TYPE.caption, fontWeight: '700' },

  // Note editor modal
  noteSheet: { backgroundColor: COLORS.surfaceNeutral, borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg, padding: SPACING.lg, paddingBottom: SPACING.xl, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  noteSheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', alignSelf: 'center', marginBottom: SPACING.md },
  noteSheetTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_600SemiBold', fontSize: TYPE.subtitle, marginBottom: 4 },
  noteViewCardText: { color: COLORS.primary, fontSize: TYPE.caption, fontWeight: '600' },

  // Note editor — full-screen (A1)
  noteTopBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.sm, paddingTop: Platform.OS === 'web' ? 12 : SPACING.sm, paddingBottom: SPACING.sm }, // the SafeAreaView above already supplies the notch inset
  noteMenuButton: { paddingHorizontal: 10, paddingVertical: 8 },
  noteMenuButtonText: { color: COLORS.primary, fontSize: 20, fontWeight: '700', letterSpacing: 1 },
  noteDoneText: { color: COLORS.primary, fontSize: TYPE.body, fontWeight: '700' },
  noteMenuPopover: { position: 'absolute', top: 104, right: SPACING.md, backgroundColor: COLORS.surfaceNeutral, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 6, minWidth: 190, zIndex: 50 },
  noteMenuItem: { paddingVertical: 12, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  noteMenuItemText: { color: COLORS.textPrimary, fontSize: TYPE.body },
  noteMenuDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.14)', marginVertical: 4 },
  noteScreenContent: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, paddingBottom: SPACING.xxl, flexGrow: 1 },
  noteCardContext: { borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', padding: SPACING.md },
  noteCardContextTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_600SemiBold', fontSize: TYPE.subtitle, marginBottom: 6 },
  noteCardContextHook: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18, marginBottom: 10 },
  noteStartWithLabel: { color: COLORS.textTertiary, fontSize: TYPE.micro, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '700', marginBottom: 10 },
  notePillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  notePill: { borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', paddingVertical: 8, paddingHorizontal: 14 },
  notePillText: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: '600' },
  noteWritingArea: { flex: 1, color: COLORS.textPrimary, fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21, marginTop: SPACING.lg, minHeight: 200 },
  noteHeadingLine: { color: COLORS.primary, fontFamily: 'Inter_600SemiBold', fontSize: 14, marginBottom: 2 },
  noteBodyLine: { color: COLORS.textPrimary, fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21 },
  noteSaveStatus: { color: COLORS.textMuted, fontSize: TYPE.micro, textAlign: 'center', paddingVertical: 8 },
  noteDotsRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingTop: 4 },
  // My Notes row: how many separate notes this card has, when more than one.
  notesCountBadge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(184,134,11,0.15)' },
  notesCountBadgeText: { color: COLORS.primary, fontSize: TYPE.micro, fontWeight: '700' },

  // Ask Agora — conversation history row (mode sheet) and ended-debate secondary actions
  askConvoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  askConvoRowTitle: { color: COLORS.textPrimary, fontSize: TYPE.caption, fontWeight: '700' },
  askConvoRowDate: { color: COLORS.textTertiary, fontSize: TYPE.micro },
  askConvoRowPreview: { color: COLORS.textTertiary, fontSize: TYPE.caption, marginTop: 2 },
  askEndedActions: { padding: SPACING.md, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' },
  askSecondaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', paddingVertical: 14, marginBottom: SPACING.sm, minHeight: 44 },
  askSecondaryButtonText: { color: COLORS.textPrimary, fontSize: TYPE.body, fontWeight: '600' },

  // Sharing — the 1080x1350 share image (laid out in image pixels, not screen points)
  shareImage: { width: SHARE_IMAGE_W, height: SHARE_IMAGE_H, backgroundColor: COLORS.bg, paddingHorizontal: 90, paddingTop: 84, paddingBottom: 80 },
  shareImageCategoryRow: { flexDirection: 'row', alignItems: 'center', gap: 16, height: 44, marginBottom: 28 },
  shareImageDot: { width: 20, height: 20, borderRadius: 10 },
  shareImageCategory: { fontFamily: 'Inter_600SemiBold', fontSize: 28, letterSpacing: 4, textTransform: 'uppercase' },
  shareImageTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_700Bold' },
  shareImageHook: { color: 'rgba(255,255,255,0.85)', fontFamily: 'Inter_400Regular', marginTop: 24 },
  shareNoteInput: { minHeight: 50, maxHeight: 200, paddingTop: 14, paddingBottom: 14, lineHeight: 22 },
  shareNoteMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: SPACING.xs },
  shareNoteCounter: { color: COLORS.textTertiary, fontSize: TYPE.caption },
  shareNoteDone: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACING.sm },
  shareImageNoteRegion: { flex: 1, marginTop: 32, marginBottom: 32 },
  shareImageNoteWrap: { alignSelf: 'flex-start', borderLeftWidth: 4, borderLeftColor: COLORS.primary, paddingLeft: 24 },
  shareImageNote: { color: COLORS.textSecondary, fontFamily: 'Inter_400Regular' },
  shareImageDivider: { width: 160, height: 3, backgroundColor: COLORS.primary, marginBottom: 28 },
  shareImageLabel: { color: COLORS.textTertiary, fontFamily: 'Inter_600SemiBold', fontSize: 26, letterSpacing: 5, marginBottom: 16 },
  shareImageQuestion: { color: COLORS.textPrimary, fontFamily: 'Inter_600SemiBold' },
  shareImageFooter: { flexDirection: 'row', alignItems: 'center', gap: 28, marginTop: 40, minHeight: 100 },
  shareImageLogo: { height: 100, aspectRatio: KEPOS_MARK_ASPECT },
  shareImageWordmark: { color: COLORS.textPrimary, fontFamily: 'Cinzel_700Bold', fontSize: 44, lineHeight: 54 },
  shareImageWordmarkSuffix: { color: COLORS.primary, fontFamily: 'Inter_600SemiBold', fontSize: 28, lineHeight: 40 },
  shareImageTagline: { color: COLORS.textTertiary, fontFamily: 'Inter_400Regular', fontSize: 24, lineHeight: 30 },
  shareImageLink: { color: COLORS.primary, fontFamily: 'Inter_600SemiBold', fontSize: 24, maxWidth: 340, flexShrink: 0 },
  shareCaptureHost: { position: 'absolute', left: -(SHARE_IMAGE_W + 200), top: 0, width: SHARE_IMAGE_W, height: SHARE_IMAGE_H },

  // Sharing — sheet, recipient step, inbox, banner
  sharePreviewFrame: { alignSelf: 'center', borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', overflow: 'hidden', marginBottom: SPACING.md },
  shareQuestionRow: { minHeight: 44, justifyContent: 'center', borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 12, paddingHorizontal: 14, marginBottom: SPACING.sm },
  shareQuestionRowSelected: { borderColor: COLORS.primary, backgroundColor: 'rgba(184,134,11,0.08)' },
  shareQuestionText: { color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 20 },
  shareStatusText: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18, textAlign: 'center', marginBottom: SPACING.md },
  shareHandleField: { flexDirection: 'row', alignItems: 'center', borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 14, marginBottom: SPACING.md },
  shareHandleAt: { color: COLORS.textTertiary, fontSize: TYPE.subtitle, marginRight: 2 },
  shareHandleInput: { flex: 1, color: COLORS.textPrimary, fontSize: TYPE.subtitle, paddingVertical: 14 },
  shareMatchCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(184,134,11,0.5)', padding: 12, marginBottom: SPACING.md },
  shareRecentPill: { minHeight: 44, justifyContent: 'center', maxWidth: '48%' },
  shareBanner: { marginHorizontal: SPACING.md, marginBottom: SPACING.sm, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(184,134,11,0.4)', backgroundColor: 'rgba(184,134,11,0.08)', paddingVertical: 10, paddingHorizontal: 14 },
  shareBannerText: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18 },
  shareBannerName: { color: COLORS.textPrimary, fontWeight: '700' },
  shareBannerNote: { color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 20, marginTop: 6 },
  shareRowNote: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontStyle: 'italic', marginTop: 2 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary, marginRight: 8 },
  shareRowQuestion: { color: COLORS.textTertiary, fontSize: TYPE.caption },

  // Secure account / sign in
  secureContent: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, paddingBottom: SPACING.xxl },
  secureHelp: { color: COLORS.textSecondary, fontSize: TYPE.body, lineHeight: 22, marginBottom: SPACING.md },
  secureInput: { color: COLORS.textPrimary, fontSize: TYPE.subtitle, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 14, paddingVertical: 14, marginBottom: SPACING.md },
  secureCodeInput: { fontSize: TYPE.title, letterSpacing: 8, textAlign: 'center' },
  secureError: { color: COLORS.error, fontSize: TYPE.caption, lineHeight: 18, marginBottom: SPACING.md },
  secureLink: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACING.sm },
  secureLinkText: { color: COLORS.primary, fontSize: TYPE.body, fontWeight: '600' },

  // Auth error banner (diagnostic — see App())
  authErrorBanner: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: COLORS.errorBg, paddingTop: 50, paddingBottom: 10, paddingHorizontal: 16, zIndex: 999, borderBottomWidth: 1, borderBottomColor: COLORS.error },
  authErrorText: { color: COLORS.error, fontSize: TYPE.caption, fontWeight: '600' },

  // Ask Agora — mode picker sheet
  askModeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 },
  askModeIconWrap: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(184,134,11,0.15)' },
  askModeTitle: { color: COLORS.textPrimary, fontSize: TYPE.body, fontWeight: '700', marginBottom: 2 },
  askModeDesc: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18 },

  // Ask Agora — conversation screen
  // Positioned exactly like the rest of the app's floating back chevrons (styles.backButton:
  // top 60), instead of sitting in normal flow right under the notch/status bar.
  // In normal flow (not absolutely positioned) so it can never overlap the title below it. Native gets its top
  // space from the SafeAreaView; web has no safe-area inset, so it gets a little padding instead.
  askHeaderBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingTop: Platform.OS === 'web' ? 12 : SPACING.xs, minHeight: 48 },
  askHeaderBack: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  askHeaderTitleBlock: { paddingHorizontal: SPACING.md, paddingTop: SPACING.xs, paddingBottom: SPACING.sm },
  askHeaderTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_600SemiBold', fontSize: TYPE.subtitle },
  askHeaderMode: { color: COLORS.textTertiary, fontSize: TYPE.caption, marginTop: 1 },
  askEndDebateText: { color: COLORS.primary, fontSize: TYPE.caption, fontWeight: '700' },
  askMessagesContent: { padding: SPACING.md, paddingBottom: SPACING.xl },
  askBubbleAssistant: { alignSelf: 'flex-start', maxWidth: '88%', borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', padding: SPACING.md, marginBottom: SPACING.sm },
  askBubbleAssistantText: { color: COLORS.textSecondary, fontSize: TYPE.body, lineHeight: 22 },
  askBubbleDebrief: { borderColor: COLORS.primary, backgroundColor: 'rgba(184,134,11,0.08)' },
  askDebriefLabel: { color: COLORS.primary, fontSize: TYPE.micro, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: '700', marginBottom: 8 },

  // Explain it back screen
  explainContent: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md, paddingBottom: SPACING.xxl },
  explainTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_700Bold', fontSize: TYPE.title, lineHeight: 30, marginBottom: SPACING.md },
  explainGuidance: { color: COLORS.textSecondary, fontSize: TYPE.body, lineHeight: 22, marginBottom: SPACING.md },
  explainInput: { color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 22, minHeight: 200, maxHeight: 320, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 14, paddingTop: 14, paddingBottom: 14 },
  explainCounter: { color: COLORS.textTertiary, fontSize: TYPE.caption, textAlign: 'right', marginTop: SPACING.xs },
  explainTip: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18, textAlign: 'center', marginTop: SPACING.xs },
  conversationKindLabel: { color: COLORS.textTertiary, fontSize: TYPE.micro, fontWeight: '600', marginRight: 6 },

  // Prepare
  prepareHintRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  prepareHint: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18, flexShrink: 1 },
  prepareChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  prepareChip: { minHeight: 44, justifyContent: 'center', borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 16 },
  prepareChipSelected: { borderColor: COLORS.primary },
  prepareChipText: { color: COLORS.textSecondary, fontSize: TYPE.body, fontWeight: '600' },
  prepareChipTextSelected: { color: COLORS.primary },
  prepareHeading: { color: COLORS.textPrimary, fontFamily: 'Cinzel_700Bold', fontSize: TYPE.title, lineHeight: 30 },
  prepareSub: { color: COLORS.textTertiary, fontSize: TYPE.body, marginTop: 2, marginBottom: SPACING.md },
  prepareCard: { borderRadius: RADIUS.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', padding: SPACING.md, marginBottom: SPACING.md },
  prepareCardTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_600SemiBold', fontSize: TYPE.subtitle, lineHeight: 24, marginBottom: SPACING.sm },
  prepareWhy: { color: COLORS.textSecondary, fontSize: TYPE.body, lineHeight: 21, marginBottom: SPACING.sm },
  prepareOpener: { color: COLORS.textPrimary, fontSize: 16, lineHeight: 23, marginBottom: SPACING.sm },
  prepareFollowUp: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18 },
  askBubbleUserWrap: { alignItems: 'flex-end', marginBottom: SPACING.sm },
  askBubbleUser: { maxWidth: '88%', borderRadius: RADIUS.md, backgroundColor: COLORS.surfaceNeutral, padding: SPACING.md },
  askBubbleUserText: { color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 22 },
  askLimitText: { color: COLORS.textTertiary, fontSize: TYPE.caption, textAlign: 'center', lineHeight: 20, marginTop: SPACING.sm },
  askErrorText: { color: COLORS.error, fontSize: TYPE.caption, textAlign: 'center', marginTop: SPACING.sm },
  askInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: SPACING.md, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' },
  askInput: { flex: 1, color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 20, maxHeight: 100, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 14, paddingVertical: 10 },
  askSendButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary },

  // "Debate this" links under discussion questions (ConceptCard 'questions' page)
  debateQuestionBlock: { marginBottom: 20 },
  debateLinkWrap: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  debateLinkText: { color: COLORS.primary, fontSize: TYPE.micro, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },

    teaserCard: { borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
    teaserHook: { color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 21, fontStyle: 'italic', marginBottom: 6 },
  teaserAttribution: { color: COLORS.primary, fontSize: TYPE.caption, fontWeight: '600' },


  // Install banner (web only)
  installBanner: { position: 'absolute', left: 16, right: 16, bottom: 112, zIndex: 50, backgroundColor: COLORS.surfaceNeutral, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: 'rgba(184,134,11,0.5)', paddingLeft: SPACING.md, paddingRight: SPACING.xs, paddingVertical: SPACING.xs },
  installBannerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52 },
  installBannerText: { flex: 1, color: COLORS.textPrimary, fontSize: TYPE.caption, lineHeight: 18, fontWeight: '600' },
  installBannerButton: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.primary, paddingHorizontal: 12 },
  installBannerButtonText: { color: COLORS.primary, fontSize: TYPE.caption, fontWeight: '700' },
  installBannerClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  installBannerArrow: { alignItems: 'center', paddingBottom: 4 },
  // Tab bar: floating pill, five tabs, icon + label beneath (min 44pt touch target each)
  tabBarWrap: { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center' },
  tabBar: { flexDirection: 'row', borderRadius: 34, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 6, paddingVertical: 4, overflow: 'hidden', ...(Platform.OS === 'web' ? { boxShadow: '0px 6px 14px rgba(0,0,0,0.3)' } : { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 14, elevation: 10 }) },
  tabItem: { minHeight: 52, minWidth: 44, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.2 },
  tabDot: { position: 'absolute', top: -1, right: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary, borderWidth: 1.5, borderColor: COLORS.bg },
  // Tab panes: every visited tab stays mounted; inactive ones are hidden (keeps scroll position)
  tabPane: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  tabPaneHidden: { display: 'none' },
  // Identical content padding for Learn, Games, Library and Profile (room for the tab bar below)
  tabListContent: { paddingHorizontal: 28, paddingTop: 0, paddingBottom: 150 },

  // Home: today's conversation + with friends
  convoCard: { borderRadius: RADIUS.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', padding: SPACING.md, marginBottom: SPACING.xs },
  convoTitle: { color: COLORS.textPrimary, fontFamily: 'Cinzel_600SemiBold', fontSize: TYPE.title, lineHeight: 28, marginBottom: SPACING.sm },
  convoHook: { color: COLORS.textSecondary, fontSize: TYPE.body, lineHeight: 22 },
  convoDivider: { height: 1, backgroundColor: COLORS.primary, opacity: 0.7, marginTop: SPACING.md, marginBottom: SPACING.md },
  convoLabel: { color: COLORS.textTertiary, fontSize: TYPE.micro, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: '700', marginBottom: 6 },
  convoQuestion: { color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 21, fontWeight: '600' },
  friendsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 14, paddingHorizontal: 16 },
  friendsRowText: { flex: 1, color: COLORS.textSecondary, fontSize: TYPE.body, lineHeight: 21 },

  // Learn
  learnRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 12, paddingHorizontal: 14 },
  learnRowText: { flex: 1, color: COLORS.textPrimary, fontSize: TYPE.body, fontWeight: '600' },
  learnGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: SPACING.sm },
  learnTile: { width: '48%', minHeight: 72, justifyContent: 'center', gap: 6, borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingVertical: 12, paddingHorizontal: 14 },
  learnTileTitle: { flex: 1, color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 20, fontWeight: '600' },
  moreIdeasLink: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: SPACING.sm },
  moreIdeasLinkText: { color: COLORS.primary, fontSize: TYPE.body, fontWeight: '600' },
  learnTileCount:{ color: COLORS.textTertiary, fontSize: TYPE.caption },

  // Library: segmented control + filter chip
  segmented: { flexDirection: 'row', borderRadius: RADIUS.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', padding: 3, marginBottom: SPACING.md },
  // Widths follow the label (flexBasis auto) so "Conversations" gets the room it needs and never truncates.
  segment: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: RADIUS.sm, paddingHorizontal: 6 },
  segmentSelected: { backgroundColor: 'rgba(255,255,255,0.12)' },
  segmentText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  segmentTextSelected: { color: '#ffffff', fontWeight: '600' },
  segmentDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.primary },
  libraryFilterChip: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, marginBottom: SPACING.sm },
  libraryFilterChipText: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: '600' },

  // Profile
  profileEditButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  interestSubLabel: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: '600', marginBottom: 8 },
  interestRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  interestName: { flex: 1, color: COLORS.textPrimary, fontSize: TYPE.body, fontWeight: '600' },
  interestCount: { color: COLORS.textTertiary, fontSize: TYPE.caption },

  // Quiz
    streakCorner: { position: 'absolute', top: 10, right: 12, flexDirection: 'row', alignItems: 'center', gap: 3, zIndex: 10 },
  streakCornerText: { color: COLORS.primary, fontSize: TYPE.micro, fontWeight: '700' },
  quizContainer: { padding: 28, paddingTop: 100, paddingBottom: 60 },
  // Shared header (ScreenHeader / ScreenTitleBlock) for My Notes, Conversations, Saved and
  // Quiz History. The nav row sits directly under the top safe area (the root SafeAreaView),
  // in normal flow, instead of the old floating back button with a large gap above it.
  screenNavRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.sm, paddingTop: SPACING.xs, minHeight: 48 },
  screenBackButton: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, paddingHorizontal: SPACING.sm },
  screenActionButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  // Tab screens (Learn, Games, Library, Profile): a slimmer nav row so the big title sits right under the status bar.
  screenNavRowCompact: { paddingTop: 0, minHeight: 36 },
  screenActionButtonCompact: { width: 36, height: 36 },
  screenCollapsedTitleCompact: { top: 0, lineHeight: 36 },
  screenCollapsedTitle: { position: 'absolute', left: 0, right: 0, top: SPACING.xs, lineHeight: 44, textAlign: 'center', paddingHorizontal: 100, color: COLORS.textPrimary, fontFamily: 'Cinzel_600SemiBold', fontSize: TYPE.body },
  screenMenuItemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  screenSearchField: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: 'rgba(255,255,255,0.06)', marginBottom: SPACING.lg },
  screenListContent: { paddingHorizontal: 28, paddingTop: SPACING.sm, paddingBottom: 60 },
  screenCountFooter: { color: COLORS.textTertiary, fontSize: TYPE.caption, textAlign: 'center', marginTop: SPACING.sm },
  quizProgress: { color: COLORS.textTertiary, fontSize: TYPE.caption, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 },
  questionText: { color: COLORS.textPrimary, fontSize: TYPE.title, fontWeight: '700', marginBottom: 28, lineHeight: 30 },
  optionButton: { borderRadius: RADIUS.md, paddingVertical: 16, paddingHorizontal: 18, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  optionButtonCorrect: { backgroundColor: COLORS.successBg, borderRadius: RADIUS.md, paddingVertical: 16, paddingHorizontal: 18, marginBottom: 12, borderWidth: 1, borderColor: COLORS.success },
  optionButtonWrong: { backgroundColor: COLORS.errorBg, borderRadius: RADIUS.md, paddingVertical: 16, paddingHorizontal: 18, marginBottom: 12, borderWidth: 1, borderColor: COLORS.error },
  optionText: { color: COLORS.textPrimary, fontSize: TYPE.body, lineHeight: 21 },
  nextButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingVertical: 16, marginTop: 12 },
  nextButtonText: { color: COLORS.primaryText, fontSize: 16, fontWeight: '700' },
  quizDoneEmoji: { fontSize: 48, marginBottom: 16 },
  resultText: { color: COLORS.textPrimary, fontSize: 20, fontWeight: '700', marginBottom: 6 },
  resultScore: { color: COLORS.primary, fontSize: 36, fontWeight: '800', marginBottom: 16 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', borderRadius: RADIUS.sm, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  historyDate: { color: COLORS.textSecondary, fontSize: TYPE.caption },
  historyScore: { color: COLORS.primary, fontSize: TYPE.caption, fontWeight: '700' },
  reviewCard: { borderRadius: RADIUS.md, marginBottom: 10, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  reviewHeader: { flexDirection: 'row', alignItems: 'flex-start', padding: 16 },

  reviewQuestion: { color: COLORS.textSecondary, fontSize: TYPE.caption, flex: 1, lineHeight: 20 },
  reviewBody: { paddingHorizontal: 16, paddingBottom: 16 },
  reviewConceptTitle: { color: COLORS.primary, fontSize: TYPE.body, fontWeight: '700', marginBottom: 8 },
  reviewConceptText: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 20, marginBottom: 12 },
  backButtonRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  // Games hub
    gameHubCard: { flexDirection: 'row', alignItems: 'center', borderRadius: RADIUS.lg, padding: 16, marginBottom: 12, gap: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
    gameHubIconWrap: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  gameHubEmoji: { fontSize: 32 },
  gameHubTitle: { color: COLORS.textPrimary, fontSize: TYPE.subtitle, fontWeight: '700', marginBottom: 4 },
  gameHubDesc: { color: COLORS.textTertiary, fontSize: TYPE.caption, lineHeight: 18 },
  gameLabel: { color: COLORS.textTertiary, fontSize: TYPE.caption, marginBottom: 12, lineHeight: 19 },

  emojiDisplayLarge: { fontSize: 72, marginVertical: 24 },

  emojiRevealHook: { color: COLORS.textSecondary, fontSize: TYPE.body, lineHeight: 22, textAlign: 'center', marginTop: 8, marginBottom: 20 },

  // Crossword
  crosswordGrid: { alignSelf: 'center', marginTop: 8 },
  crosswordCell: { borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface, color: COLORS.textPrimary, textAlign: 'center', fontWeight: '700' },
  crosswordCellCorrect: { borderWidth: 1, borderColor: COLORS.success, backgroundColor: COLORS.successBg, color: COLORS.textPrimary, textAlign: 'center', fontWeight: '700' },
  crosswordCellWrong: { borderWidth: 1, borderColor: COLORS.error, backgroundColor: COLORS.errorBg, color: COLORS.textPrimary, textAlign: 'center', fontWeight: '700' },
  crosswordBlock: { backgroundColor: COLORS.bg },
  crosswordCellNumber: { position: 'absolute', top: 1, left: 2, color: COLORS.textTertiary, zIndex: 1 },
  clueRow: { flexDirection: 'row', borderRadius: RADIUS.sm, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8, gap: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  clueNumber: { color: COLORS.primary, fontWeight: '700', fontSize: TYPE.caption, minWidth: 22 },
  clueText: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 20, flex: 1 },
});
