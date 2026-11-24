import { z } from '@alleneubank/incur'

/** Public OAuth client id of this CLI's Slack app, the shared app. PKCE; no client secret. */
export const SLACK_OAUTH_CLIENT_ID: string = '12085301315143.12095834471045'

/** Whether a workspace signs in through the shared app or an app of its own. */
export const slackAppSchema: z.ZodEnum<{ shared: 'shared'; own: 'own' }> = z
  .enum(['shared', 'own'])
  .describe("shared: this CLI's app; own: any other app, such as one created in the workspace")

type SlackApp = z.infer<typeof slackAppSchema>

const clientIdPattern = /^\d+\.\d+$/

/**
 * Parses a `--client-id` or `SLACK_CLIENT_ID` value: a Slack app's client id,
 * or `shared` for this CLI's app. Undefined when it is neither.
 */
export function parseClientId(value: string): string | undefined {
  if (value === 'shared') return SLACK_OAUTH_CLIENT_ID
  return clientIdPattern.test(value) ? value : undefined
}

export function slackApp(clientId: string): SlackApp {
  return clientId === SLACK_OAUTH_CLIENT_ID ? 'shared' : 'own'
}
