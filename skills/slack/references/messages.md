# Messages

## From a message link

`https://<workspace>.slack.com/archives/C0123456789/p1789757627925439` is
channel `C0123456789` and message `ts` `1789757627.925439` (a dot before the
last six digits). A `thread_ts` query parameter names the thread's parent.

- That message: `slack conversations history C0123456789 --oldest 1789757627.925439 --latest 1789757627.925439 --inclusive true --limit 1`
- Its thread: `slack conversations replies C0123456789 <thread_ts, else ts>`
- A link for a message: `slack chat getPermalink <channel> <ts>`

## Threads

- Reply: `slack chat postMessage <channel> --thread_ts <parent ts> --text '…'`.
  `--reply_broadcast true` also shows the reply in the channel.
- A reply's `thread_ts` is its parent's `ts`; a parent with replies has
  `reply_count`.

## Direct messages

`slack conversations open --users U0123456789` returns `channel.id` (`D…`);
post there with `slack chat postMessage <that id> --text '…'`. Several
comma-separated users open a group DM.

## Formatting

Message text is Slack mrkdwn, not Markdown:

- `*bold*`, `_italic_`, `~strike~`, `` `code` ``, triple-backtick blocks, and
  `> quote`. `**bold**` and `# heading` show literally.
- `<@U0123456789>` mentions a person and `<#C0123456789>` links a channel; a
  plain `@name` is not a mention. `<!here>` and `<!channel>` notify everyone
  in the channel: confirm with the user first.
- Links are `<https://example.com|text>`. Escape a literal `&`, `<`, `>` as
  `&amp;`, `&lt;`, `&gt;`.

## Edit, delete, schedule

- `slack chat update <channel> <ts> --text '…'` and
  `slack chat delete <channel> <ts>`; Slack answers `cant_update_message` or
  `cant_delete_message` for messages the person may not change.
- `slack chat scheduleMessage --channel C… --post_at <unix seconds> --text '…'`;
  `slack chat scheduledMessages list` and `slack chat deleteScheduledMessage`
  manage pending ones.
