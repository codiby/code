//! The installer's look: HeroUI v3's dark theme (surfaces, borders, radii)
//! with Codiby's blue, Lucide-style stroke icons, and the window's own title
//! bar. Every screen is built from these.

use nsh_base::{button, input};
use nsh_core::{
    element::{
        AnyElement, ImageSrc,
        desktop::{current_window, quit},
    },
    prelude::*,
};

// --- Palette (HeroUI v3 dark, Codiby blue) -----------------------------------

/// The window (HeroUI `--background`, 12% lightness).
pub const BACKGROUND: u32 = 0x0a0a0c;
/// Cards, fields (HeroUI `--surface`).
pub const SURFACE: u32 = 0x18181b;
/// Hovered surfaces, tiles, tracks (HeroUI `--surface-secondary`).
pub const SURFACE_2: u32 = 0x232327;
/// HeroUI `--border`, 1px.
pub const BORDER: u32 = 0x29292d;
/// HeroUI `--separator`.
pub const SEPARATOR: u32 = 0x222226;
pub const FOREGROUND: u32 = 0xfafafa;
pub const MUTED: u32 = 0xa1a1aa;
pub const DIM: u32 = 0x71717a;
/// Codiby's blue ("Azul Claro Codiby" in the isotipo, its start).
pub const ACCENT: u32 = 0x2975d3;
/// The same gradient's end: hovers, links.
pub const ACCENT_LIGHT: u32 = 0x3697f5;
pub const DANGER: u32 = 0xf31260;
pub const WARNING: u32 = 0xf5a524;
pub const SUCCESS: u32 = 0x17c964;

/// HeroUI `--radius` (0.5rem) and `--field-radius` (1.5×).
const RADIUS: f32 = 8.0;
const FIELD_RADIUS: f32 = 12.0;

/// A `0xRRGGBB` color with `alpha` opacity (0 to 1).
pub fn rgb_a(hex: u32, alpha: f32) -> Rgba {
    rgba((hex << 8) | (alpha.clamp(0.0, 1.0) * 255.0).round() as u32)
}

// --- Icons -------------------------------------------------------------------

/// An SVG icon from stroke paths on a 24×24 grid.
pub fn svg(paths: &str, color: u32) -> ImageSrc {
    ImageSrc::svg_markup(&format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' \
         stroke='#{color:06x}' stroke-width='1.8' stroke-linecap='round' \
         stroke-linejoin='round'>{paths}</svg>"
    ))
}

/// Codiby's isotipo, the official one (`assets/isotipo.svg`).
pub fn logo(size: f32) -> AnyElement {
    image(ImageSrc::svg_markup(include_str!("../assets/isotipo.svg")))
        .size(px(size))
        .into_element()
}

pub const MINUS: &str = "<path d='M5 12h14'/>";
pub const X: &str = "<path d='M18 6 6 18M6 6l12 12'/>";
pub const CHECK: &str = "<path d='M20 6 9 17l-5-5'/>";
pub const ALERT: &str = "<path d='m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'/><path d='M12 9v4M12 17h.01'/>";
pub const ROTATE: &str = "<path d='M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'/><path d='M21 3v5h-5'/>";
pub const MONITOR: &str = "<rect x='2' y='3' width='20' height='14' rx='2'/><path d='M8 21h8M12 17v4'/>";
pub const TERMINAL: &str = "<path d='m4 17 6-6-6-6M12 19h8'/>";
pub const SERVER: &str = "<rect x='2' y='2' width='20' height='8' rx='2'/><rect x='2' y='14' width='20' height='8' rx='2'/><path d='M6 6h.01M6 18h.01'/>";
pub const PLUS: &str = "<path d='M5 12h14M12 5v14'/>";
pub const BAN: &str = "<circle cx='12' cy='12' r='10'/><path d='m4.9 4.9 14.2 14.2'/>";
pub const INFO: &str = "<circle cx='12' cy='12' r='10'/><path d='M12 16v-4M12 8h.01'/>";
pub const GLOBE: &str = "<circle cx='12' cy='12' r='10'/><path d='M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20'/>";
pub const CPU: &str = "<rect x='4' y='4' width='16' height='16' rx='2'/><rect x='9' y='9' width='6' height='6' rx='1'/><path d='M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2'/>";
pub const USER: &str = "<path d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'/><circle cx='12' cy='7' r='4'/>";

// --- Window ------------------------------------------------------------------

/// The window's own title bar: it drags the window, and has its minimize and
/// close buttons (the window has no system frame).
pub fn title_bar() -> AnyElement {
    view()
        .h(px(42.0))
        .flex_row()
        .items_center()
        .justify_between()
        .pl_4()
        .pr_1p5()
        .window_drag(true)
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(logo(15.0))
                .child(
                    text("Codiby Code")
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(rgb(MUTED)),
                ),
        )
        .child(
            view()
                .flex_row()
                .gap_0p5()
                .window_drag(false)
                .child(chrome_button(MINUS, false, || current_window().minimize()))
                .child(chrome_button(X, true, quit)),
        )
        .into_element()
}

fn chrome_button(icon: &'static str, danger: bool, on_press: impl Fn() + 'static) -> AnyElement {
    button()
        .on_press(on_press)
        .size(px(32.0))
        .rounded(px(RADIUS))
        .items_center()
        .justify_center()
        .hover(move |s| s.bg(if danger { rgb_a(DANGER, 0.85) } else { rgb(SURFACE_2) }))
        .active(|s| s.opacity(0.7))
        .child(image(svg(icon, MUTED)).size(px(14.0)))
        .into_element()
}

// --- Layout ------------------------------------------------------------------

/// The column every screen sits in, centered in the window.
pub fn screen(children: Vec<AnyElement>) -> impl IntoElement {
    view().w_full().items_center().children(children)
}

/// A round status icon on a tint of its color.
pub fn icon(paths: &'static str, color: u32) -> AnyElement {
    view()
        .size(px(52.0))
        .mb_4()
        .rounded_full()
        .bg(rgb_a(color, 0.12))
        .border_1()
        .border_color(rgb_a(color, 0.25))
        .items_center()
        .justify_center()
        .child(image(svg(paths, color)).size(px(24.0)))
        .into_element()
}

/// A rounded square holding an icon, as HeroUI's list items.
fn tile(paths: &'static str, color: u32, bg: Rgba) -> AnyElement {
    view()
        .size(px(36.0))
        .rounded(px(10.0))
        .bg(bg)
        .items_center()
        .justify_center()
        .child(image(svg(paths, color)).size(px(18.0)))
        .into_element()
}

pub fn title(label: impl Fn() -> String + 'static) -> AnyElement {
    text(label)
        .text_size(px(20.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_center()
        .mb_1p5()
        .text_color(rgb(FOREGROUND))
        .into_element()
}

pub fn sub(label: impl Fn() -> String + 'static) -> AnyElement {
    text(label)
        .text_size(px(13.5))
        .text_center()
        .max_w(px(400.0))
        .mb_6()
        .text_color(rgb(MUTED))
        .into_element()
}

/// A row of buttons under a screen's content.
pub fn actions(children: Vec<AnyElement>) -> AnyElement {
    view().flex_row().gap_2().justify_center().children(children).into_element()
}

// --- Buttons -----------------------------------------------------------------

pub fn primary(label: impl Fn() -> String + 'static, on_press: impl Fn() + 'static) -> AnyElement {
    primary_if(|| true, label, on_press)
}

/// The main button (HeroUI `primary`), enabled while `enabled` holds.
pub fn primary_if(
    enabled: impl Fn() -> bool + 'static,
    label: impl Fn() -> String + 'static,
    on_press: impl Fn() + 'static,
) -> AnyElement {
    button()
        .disabled(move || !enabled())
        .on_press(on_press)
        .h(px(40.0))
        .px_6()
        .items_center()
        .justify_center()
        .rounded(px(FIELD_RADIUS))
        .bg(rgb(ACCENT))
        .hover(|s| s.bg(rgb(ACCENT_LIGHT)))
        .active(|s| s.opacity(0.85))
        .disabled_style(|s| s.opacity(0.4))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(rgb(ACCENT_LIGHT)))
        .child(
            text(label)
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(0xffffff)),
        )
        .into_element()
}

/// The second button (HeroUI `tertiary`): a quiet surface.
pub fn ghost(label: impl Fn() -> String + 'static, on_press: impl Fn() + 'static) -> AnyElement {
    button()
        .on_press(on_press)
        .h(px(40.0))
        .px_5()
        .items_center()
        .justify_center()
        .rounded(px(FIELD_RADIUS))
        .bg(rgb(SURFACE))
        .hover(|s| s.bg(rgb(SURFACE_2)))
        .active(|s| s.opacity(0.7))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(rgb(ACCENT_LIGHT)))
        .child(
            text(label)
                .text_size(px(13.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgb(FOREGROUND)),
        )
        .into_element()
}

/// A small link, with an optional leading icon.
pub fn link(
    icon: Option<&'static str>,
    label: impl Fn() -> String + 'static,
    on_press: impl Fn() + 'static,
) -> AnyElement {
    let mut row = button()
        .on_press(on_press)
        .flex_row()
        .items_center()
        .gap_1p5()
        .px_2()
        .py_1()
        .rounded(px(RADIUS))
        .hover(|s| s.bg(rgb(SURFACE)))
        .active(|s| s.opacity(0.6));
    if let Some(icon) = icon {
        row = row.child(image(svg(icon, MUTED)).size(px(13.0)));
    }
    row.child(text(label).text_size(px(12.0)).text_color(rgb(MUTED)))
        .into_element()
}

// --- Options -----------------------------------------------------------------

/// How an option marks its state.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Radio,
    Check,
    /// An option that leads somewhere instead of picking: a chevron.
    More,
}

/// A selectable card: an icon, a title, a line under it, an optional chip,
/// and its radio or checkbox at the end.
#[allow(clippy::too_many_arguments)]
pub fn option(
    mark: Mark,
    icon: &'static str,
    selected: impl Fn() -> bool + 'static,
    enabled: impl Fn() -> bool + 'static,
    label: impl Fn() -> String + 'static,
    detail: impl Fn() -> String + 'static,
    pill: impl Fn() -> Option<(String, bool)> + 'static,
    on_press: impl Fn() + 'static,
) -> AnyElement {
    // Copyable handles, so every binding below can read them.
    let selected = {
        let c = computed(selected);
        move || c.get()
    };
    let enabled = {
        let c = computed(enabled);
        move || c.get()
    };
    let pill = {
        let c = computed(pill);
        move || c.get()
    };
    let marker = match mark {
        Mark::Radio => view()
            .size(px(18.0))
            .rounded_full()
            .border(px(2.0))
            .border_color(move || if selected() { rgb(ACCENT) } else { rgb(0x52525b) })
            .bg(move || if selected() { rgb(ACCENT) } else { rgb_a(ACCENT, 0.0) })
            .items_center()
            .justify_center()
            .child(when(selected, || view().size(px(6.0)).rounded_full().bg(rgb(0xffffff))))
            .into_element(),
        Mark::Check => view()
            .size(px(18.0))
            .rounded(px(6.0))
            .border(px(2.0))
            .border_color(move || if selected() { rgb(ACCENT) } else { rgb(0x52525b) })
            .bg(move || if selected() { rgb(ACCENT) } else { rgb_a(ACCENT, 0.0) })
            .items_center()
            .justify_center()
            .child(when(selected, || image(svg(CHECK, 0xffffff)).size(px(12.0))))
            .into_element(),
        Mark::More => image(svg("<path d='m9 18 6-6-6-6'/>", DIM)).size(px(16.0)).into_element(),
    };
    button()
        .selected(selected)
        .disabled(move || !enabled())
        .on_press(on_press)
        .w_full()
        .flex_row()
        .items_center()
        .gap_3()
        .pl_3()
        .pr_4()
        .py_3()
        .rounded(px(FIELD_RADIUS))
        .border_1()
        .border_color(move || if selected() { rgb(ACCENT) } else { rgb(BORDER) })
        .bg(move || if selected() { rgb_a(ACCENT, 0.08) } else { rgb(SURFACE) })
        .hover(|s| s.bg(rgb(SURFACE_2)))
        .active(|s| s.opacity(0.85))
        .disabled_style(|s| s.opacity(0.4))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(rgb(ACCENT_LIGHT)))
        .child(dynamic(move || {
            if selected() {
                tile(icon, ACCENT_LIGHT, rgb_a(ACCENT, 0.18))
            } else {
                tile(icon, MUTED, rgb(SURFACE_2))
            }
        }))
        .child(
            view()
                .flex_1()
                .min_w(px(0.0))
                .gap_0p5()
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(
                            text(label)
                                .text_size(px(14.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(rgb(FOREGROUND)),
                        )
                        .child(when(move || pill().is_some(), move || chip(pill))),
                )
                .child(text(detail).text_size(px(12.5)).text_color(rgb(MUTED))),
        )
        .child(marker)
        .into_element()
}

/// HeroUI's chip: a small rounded label on a tint.
fn chip(pill: impl Fn() -> Option<(String, bool)> + Copy + 'static) -> AnyElement {
    let color = move || if pill().is_some_and(|(_, warn)| warn) { WARNING } else { ACCENT_LIGHT };
    view()
        .px_2()
        .py_0p5()
        .rounded_full()
        .bg(move || rgb_a(color(), 0.14))
        .child(
            text(move || pill().map(|(label, _)| label).unwrap_or_default())
                .text_size(px(11.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || rgb(color())),
        )
        .into_element()
}

/// A column of options.
pub fn options(children: Vec<AnyElement>) -> AnyElement {
    view().w_full().gap_2().mb_6().children(children).into_element()
}

// --- Notes, summary, fields, progress -----------------------------------------

/// HeroUI's alert: a tinted box with an icon.
pub fn note(warn: bool, label: impl Fn() -> String + 'static) -> AnyElement {
    let color = if warn { WARNING } else { ACCENT_LIGHT };
    view()
        .w_full()
        .flex_row()
        .gap_2p5()
        .mt(px(-8.0))
        .mb_6()
        .px_3p5()
        .py_3()
        .rounded(px(FIELD_RADIUS))
        .bg(rgb_a(color, 0.10))
        .border_1()
        .border_color(rgb_a(color, 0.22))
        .child(image(svg(if warn { ALERT } else { INFO }, color)).size(px(16.0)))
        .child(text(label).flex_1().text_size(px(12.5)).text_color(rgb(0xe4e4e7)))
        .into_element()
}

/// Label-value rows on a surface, split by separators.
pub fn summary(rows: impl Fn() -> Vec<(String, String)> + 'static) -> AnyElement {
    view()
        .w_full()
        .mb_6()
        .rounded(px(FIELD_RADIUS))
        .bg(rgb(SURFACE))
        .border_1()
        .border_color(rgb(BORDER))
        .child(dynamic(move || {
            rows()
                .into_iter()
                .enumerate()
                .map(|(i, (label, value))| {
                    view()
                        .flex_row()
                        .justify_between()
                        .gap_4()
                        .px_4()
                        .py_3()
                        .border_t(px(if i == 0 { 0.0 } else { 1.0 }))
                        .border_color(rgb(SEPARATOR))
                        .child(text(label).text_size(px(13.0)).text_color(rgb(MUTED)))
                        .child(
                            text(value)
                                .text_size(px(13.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(rgb(FOREGROUND)),
                        )
                        .into_element()
                })
                .collect::<Vec<_>>()
        }))
        .into_element()
}

/// HeroUI's text field: a label over a borderless surface that rings blue on
/// focus.
pub fn field(
    id: &'static str,
    label: impl Fn() -> String + 'static,
    masked: bool,
    value: impl Fn() -> String + 'static,
    on_change: impl Fn(String) + 'static,
) -> AnyElement {
    let label = computed(label);
    view()
        .flex_1()
        .gap_1p5()
        .child(
            text(move || label.get())
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgb(MUTED)),
        )
        .child(
            input()
                .value(value)
                .on_change(move |text: &str| on_change(text.to_owned()))
                .placeholder(move || label.get())
                .test_id(id)
                .masked(masked)
                .auto_capitalize(AutoCapitalize::None)
                .auto_correct(false)
                .placeholder_color(|| -> Hsla { rgb(DIM).into() })
                .caret_color(|| -> Hsla { rgb(ACCENT_LIGHT).into() })
                .h(px(40.0))
                .px_3()
                .text_size(px(13.5))
                .rounded(px(FIELD_RADIUS))
                .bg(rgb(SURFACE))
                .border(px(2.0))
                .border_color(rgb_a(ACCENT, 0.0))
                .hover(|s| s.bg(rgb(SURFACE_2)))
                .focus(|s| s.border_color(rgb(ACCENT)))
                .text_color(rgb(FOREGROUND)),
        )
        .into_element()
}

/// A thin bar, `value` from 0 to 1.
pub fn progress_bar(value: impl Fn() -> f32 + 'static) -> AnyElement {
    view()
        .w_full()
        .h(px(6.0))
        .my_3()
        .rounded_full()
        .bg(rgb(SURFACE_2))
        .overflow_hidden()
        .child(view().h_full().w(move || relative(value())).rounded_full().bg(rgb(ACCENT)))
        .into_element()
}

/// The dots under the window: one per stage, the current one wide.
pub fn dots(current: impl Fn() -> usize + Copy + 'static, count: usize) -> AnyElement {
    view()
        .flex_row()
        .gap_1p5()
        .justify_center()
        .items_center()
        .h(px(22.0))
        .children(
            (0..count)
                .map(|i| {
                    view()
                        .h(px(6.0))
                        .w(move || px(if current() == i { 18.0 } else { 6.0 }))
                        .rounded_full()
                        .bg(move || if current() == i { rgb(ACCENT) } else { rgb(SURFACE_2) })
                        .into_element()
                })
                .collect::<Vec<_>>(),
        )
        .into_element()
}
