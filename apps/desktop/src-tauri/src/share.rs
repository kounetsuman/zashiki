//! Opens the macOS share sheet (AirDrop, Messages, Notes, …) for a piece of text.

use std::cell::RefCell;
use std::ffi::c_void;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSSharingServicePicker, NSView};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString};

/// Where the share sheet points: the button's rect in WebView CSS pixels (top-left origin).
#[derive(Clone, Copy, serde::Deserialize)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

thread_local! {
    // AppKit does not keep the picker alive while its popover is up, so the latest one is held here.
    static PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> = const { RefCell::new(None) };
}

/// Converts a top-left-origin rect into `view`'s coordinates, which put the origin bottom-left
/// unless the view is flipped.
fn anchor_rect(anchor: Anchor, view_height: f64, flipped: bool) -> NSRect {
    let y = if flipped {
        anchor.y
    } else {
        view_height - anchor.y - anchor.height
    };
    NSRect::new(
        NSPoint::new(anchor.x, y),
        NSSize::new(anchor.width, anchor.height),
    )
}

/// Shows the share sheet above `anchor`. Must run on the main thread with `webview` pointing at the
/// window's WKWebView.
pub fn show(webview: *mut c_void, text: &str, anchor: Anchor) {
    if MainThreadMarker::new().is_none() || webview.is_null() {
        return;
    }
    // SAFETY: Tauri hands over the live WKWebView (an NSView) on the main thread, checked above.
    let view: &NSView = unsafe { &*webview.cast::<NSView>() };
    let flipped = view.isFlipped();
    let rect = anchor_rect(anchor, view.bounds().size.height, flipped);
    let item: Retained<AnyObject> =
        Retained::into_super(Retained::into_super(NSString::from_str(text)));
    let items = NSArray::from_retained_slice(&[item]);
    // SAFETY: NSString conforms to NSPasteboardWriting, which is what the picker requires of items.
    let picker =
        unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items) };
    let above = if flipped {
        NSRectEdge::MinY
    } else {
        NSRectEdge::MaxY
    };
    picker.showRelativeToRect_ofView_preferredEdge(rect, view, above);
    PICKER.with(|slot| *slot.borrow_mut() = Some(picker));
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUTTON: Anchor = Anchor {
        x: 10.0,
        y: 20.0,
        width: 30.0,
        height: 40.0,
    };

    #[test]
    fn a_flipped_view_keeps_the_top_left_origin() {
        let rect = anchor_rect(BUTTON, 500.0, true);
        assert_eq!((rect.origin.x, rect.origin.y), (10.0, 20.0));
        assert_eq!((rect.size.width, rect.size.height), (30.0, 40.0));
    }

    #[test]
    fn an_unflipped_view_measures_from_the_bottom() {
        let rect = anchor_rect(BUTTON, 500.0, false);
        assert_eq!(rect.origin.y, 500.0 - 20.0 - 40.0);
    }
}
