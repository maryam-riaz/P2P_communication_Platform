const TAG = {
  MESH: '[MeshTransport]    ',
  NATIVE: '[NearbyConnections] ',
  SCREEN: '[SpikeScreen]      ',
  PERMS: '[Permissions]      ',
} as const;

type TagKey = keyof typeof TAG;

function fmtTag(t: TagKey, msg: string): string {
  return `${TAG[t]} ${msg}`;
}

export function logm(t: TagKey, msg: string, ...args: any[]) {
  console.log(fmtTag(t, msg), ...args);
}

export function warnm(t: TagKey, msg: string, ...args: any[]) {
  console.warn(fmtTag(t, msg), ...args);
}

export function errm(t: TagKey, msg: string, err?: any) {
  const detail = err?.message ?? err?.toString?.() ?? String(err ?? 'unknown');
  console.error(fmtTag(t, msg), detail);
  if (err?.stack) {
    console.error(fmtTag(t, 'STACK:'), err.stack);
  }
}

export function logNativeCall(
  method: string,
  args: any[],
  result?: any,
  error?: any,
) {
  if (error) {
    console.error(
      `[NativeCall] ${method}(${args.map(a => JSON.stringify(a)).join(', ')}) FAILED: ${error?.message ?? error}`,
    );
    return;
  }
  console.log(
    `[NativeCall] ${method}(${args.map(a => JSON.stringify(a)).join(', ')}) => OK`,
    result !== undefined ? result : '',
  );
}
