// Operating switches of the Edge entrypoint, read from the process environment through `get`
// (never printed). Everything is off unless explicitly the exact string `true`: AGENT_ENABLED
// is the immediate operational stop, direct tool calls exist only for an explicit test target.

export type AgentConfig = {
  enabled: boolean;
  directTools: boolean;
  allowedOrigins: string[];
};

export function readAgentConfig(get: (name: string) => string | undefined): AgentConfig {
  const on = (name: string) => get(name) === 'true';
  return {
    enabled: on('AGENT_ENABLED'),
    directTools: on('AGENT_DIRECT_TOOLS_ENABLED'),
    allowedOrigins: (get('AGENT_ALLOWED_ORIGINS') ?? '').split(',').map(o => o.trim()).filter(Boolean),
  };
}
