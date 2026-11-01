// The multiplexers hosting Claude topics, chosen at boot: the configured one for
// every topic, and herdr-core for the topics listed onto it. The code depends
// only on the port; the adapters live in multiplexer.ts and hc-mux.ts.
import { HC_BIN, HC_TOPICS, HERDR_BIN, MUX_KIND } from '../config'
import { log } from '../log'
import { HcMux, hcConnect } from './hc-mux'
import { createMultiplexer } from './multiplexer'
import { topicMuxes } from './topic-muxes'

export const muxes = topicMuxes(
  createMultiplexer(MUX_KIND, HERDR_BIN),
  HC_TOPICS.size ? new HcMux(hcConnect(HC_BIN, log)) : undefined,
  HC_TOPICS,
)
