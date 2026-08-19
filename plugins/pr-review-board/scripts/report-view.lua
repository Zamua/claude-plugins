-- The pr-review-board report pane: a document view, not an editor.
--
-- layout.sh launches nvim as `-R -M -n`, which covers the buffer itself: readonly,
-- nomodifiable, writes disabled, no swap file to collide with a second viewer. This
-- file covers what those flags cannot.

-- Diagnostics off. The same global switch `<leader>ud` flips under LazyVim, by way of
-- Snacks.toggle.diagnostics. Global rather than per-buffer, so it also covers language
-- servers that attach after startup.
vim.diagnostic.enable(false)

-- The agent rewrites both files while the operator is reading them, and nvim does not
-- notice on its own. This timer is what makes the pane live. A nomodifiable buffer
-- still reloads, so it survives the -M above.
local function recheck()
  pcall(vim.cmd, "silent checktime")
end
vim.uv.new_timer():start(2000, 2000, vim.schedule_wrap(recheck))

-- checktime defers the reload of a buffer that is not in a window, so the tab you are
-- not looking at can be stale the moment you switch to it. Re-check on arrival.
vim.api.nvim_create_autocmd({ "TabEnter", "BufEnter", "FocusGained" }, { callback = recheck })
