export const packageName = "@ai-workbench/streamdeck" as const;

export const PLUGIN_UUID = "com.blackice.ai-workbench" as const;
// Action UUIDs match the old working plugin so existing configured keys and
// saved profiles keep resolving to these actions.
export const USAGE_ACTION_UUID = `${PLUGIN_UUID}.usage-display` as const;
export const BALANCE_ACTION_UUID = `${PLUGIN_UUID}.balance-display` as const;
export const STATUS_ACTION_UUID = `${PLUGIN_UUID}.status-display` as const;
