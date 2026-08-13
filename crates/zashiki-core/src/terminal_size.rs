//! Clamps terminal size up to a practical lower bound (a port of TS `packages/shared/src/terminal-size.ts`).
//! So that the tiny sizes returned by transient frames of `FitAddon.proposeDimensions()` do not collapse the
//! shared work window, this raises them to the lower bound as a server-side last line of defense. The wire's
//! cols/rows are already integers (u32), so TS's `Math.trunc` is unnecessary.

/// Practical lower bound on terminal size. Real, usable terminals never go below this (a conservative value that only rejects transient garbage).
pub const MIN_TERMINAL_COLS: u32 = 20;
pub const MIN_TERMINAL_ROWS: u32 = 5;

/// Clamps cols/rows up to the practical lower bound. `clamped` is true only when they were raised to the
/// bound (an undersized value was detected) — the trigger condition for log metrics.
pub fn clamp_terminal_size(cols: u32, rows: u32) -> (u32, u32, bool) {
    let clamped_cols = cols.max(MIN_TERMINAL_COLS);
    let clamped_rows = rows.max(MIN_TERMINAL_ROWS);
    (
        clamped_cols,
        clamped_rows,
        clamped_cols != cols || clamped_rows != rows,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usable_size_is_unchanged() {
        assert_eq!(clamp_terminal_size(80, 24), (80, 24, false));
        assert_eq!(clamp_terminal_size(143, 40), (143, 40, false));
    }

    #[test]
    fn exact_minimum_is_not_clamped() {
        assert_eq!(
            clamp_terminal_size(MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS),
            (MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS, false)
        );
    }

    #[test]
    fn below_minimum_is_clamped_up() {
        // Transient garbage (tiny real sizes) is raised to the bound. If either cols or rows is undersized, it is clamped.
        assert_eq!(clamp_terminal_size(2, 1), (20, 5, true));
        assert_eq!(clamp_terminal_size(19, 24), (20, 24, true));
        assert_eq!(clamp_terminal_size(80, 4), (80, 5, true));
    }

    // In owned mode, all size inputs from term.open / term.resize pass through this function in control.rs and,
    // as the finalized size, are stored in TermEntry and applied to the PTY on attach/bind/rebind.
    // The guarantee that the terminal never becomes "collapsed and unusable" reduces to the following 2 properties for arbitrary input.

    fn is_usable(cols: u32, rows: u32) -> bool {
        cols >= MIN_TERMINAL_COLS && rows >= MIN_TERMINAL_ROWS
    }

    /// Invariant: for any size input (0, tiny, huge), the clamp result is always usable (at or above the bound).
    /// = the finalized size the server applies to the PTY never collapses the terminal (the core invariant).
    #[test]
    fn clamp_output_is_always_usable() {
        let samples = [0, 1, 2, 4, 5, 6, 19, 20, 21, 24, 80, 143, u32::MAX];
        for &c in &samples {
            for &r in &samples {
                let (cols, rows, _) = clamp_terminal_size(c, r);
                assert!(
                    is_usable(cols, rows),
                    "clamp({c},{r}) = ({cols},{rows}) not usable"
                );
            }
        }
    }

    /// Invariant: clamping is idempotent (passing an already-canonicalized value through again leaves it unchanged, clamped=false).
    /// = the finalized size does not waver even when passed through multiple times via multiple paths like open→resize→attach.
    #[test]
    fn clamp_is_idempotent() {
        let samples = [0, 1, 19, 20, 21, 80, u32::MAX];
        for &c in &samples {
            for &r in &samples {
                let (cols, rows, _) = clamp_terminal_size(c, r);
                assert_eq!(
                    clamp_terminal_size(cols, rows),
                    (cols, rows, false),
                    "clamp not idempotent for input ({c},{r})"
                );
            }
        }
    }
}
