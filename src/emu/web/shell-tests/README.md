Tests of the page's logic that need no browser. Run them all with

    node --test src/emu/web/shell-tests/

Each file imports modules of `../shell/` directly, which works for a module
that does not touch `document` or `window` when it is loaded. The diagnostics
sections (`shell/diag/`) are written that way so that what they conclude
(`findings(data)`) can be tested here, one file per section.
