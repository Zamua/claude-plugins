// The multiplexer hosting every Claude topic, chosen once at boot. The code
// depends only on its port; tmux and herdr live in adapters/multiplexer.ts.
import { createMultiplexer } from './multiplexer'
import type { MultiplexerPort } from './multiplexer'
import { HERDR_BIN, MUX_KIND } from '../config'

export const mux: MultiplexerPort = createMultiplexer(MUX_KIND, HERDR_BIN)
