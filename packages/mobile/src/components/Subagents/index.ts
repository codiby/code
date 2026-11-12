// Only the header entry point: `AgentsSheet` and `AgentChat` stay out of the
// barrel so importing the button doesn't load Markdown and the gesture handler
// with every chat (see `loadSheet` in AgentsButton).
export { AgentsButton } from './AgentsButton';
export type { AgentsButtonProps } from './AgentsButton';
