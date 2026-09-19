/**
 * Facts about Slack methods that the method reference does not state. Every
 * name here must exist in the catalog; building the commands asserts it.
 */

/** Required resource-id arguments taken as positionals, in order. */
export const POSITIONAL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  'chat.delete': ['channel', 'ts'],
  'chat.getPermalink': ['channel', 'message_ts'],
  'chat.postMessage': ['channel'],
  'chat.update': ['channel', 'ts'],
  'conversations.history': ['channel'],
  'conversations.info': ['channel'],
  'conversations.members': ['channel'],
  'conversations.replies': ['channel', 'ts'],
  'files.info': ['file'],
  'search.messages': ['query'],
}

/** Methods that change state although none of their documented scopes is a `:write` scope. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'admin.audit.anomaly.allow.updateItem',
  'admin.conversations.createForObjects',
  'admin.conversations.linkObjects',
  'admin.conversations.unlinkObjects',
  'admin.functions.permissions.set',
  'admin.workflows.triggers.types.permissions.set',
  'apps.auth.external.delete',
  'apps.managed.permissions.set',
  'apps.manifest.create',
  'apps.manifest.delete',
  'apps.manifest.update',
  'apps.uninstall',
  'auth.revoke',
  'dialog.open',
  'entity.acknowledgeCommentAction',
  'entity.presentComments',
  'entity.presentDetails',
  'files.remote.share',
  'functions.completeError',
  'functions.completeSuccess',
  'functions.distributions.permissions.add',
  'functions.distributions.permissions.remove',
  'functions.distributions.permissions.set',
  'oauth.v2.completeShortTokenRotation',
  'oauth.v2.exchange',
  'tooling.tokens.rotate',
  'views.open',
  'views.publish',
  'views.push',
  'views.update',
])

/**
 * Verbs whose effect destroys data or access. `remove` counts only for admin
 * methods, which act on other people (a user, an app permission); removing
 * your own reaction, pin, or bookmark is undone by adding it back.
 */
const destructiveVerb = /^(archive|delete|disconnect|invalidate|kick|reset|revoke|uninstall)/

export function isDestructive(method: string): boolean {
  const verb = method.slice(method.lastIndexOf('.') + 1)
  return destructiveVerb.test(verb) || (method.startsWith('admin.') && verb.startsWith('remove'))
}
