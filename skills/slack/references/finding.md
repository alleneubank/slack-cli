# Finding things

## A channel by name

No method takes a channel name. Page through the list and match `name`
(without `#`); `slack conversations info <id> --include_num_members true` adds
the member count:

```sh
slack conversations list --types public_channel,private_channel --exclude_archived true \
  --limit 200 --filter-output 'channels[].id,channels[].name,response_metadata.next_cursor'
```

## A person

- By email: `slack users lookupByEmail --email ada@example.com`.
- By name: page `slack users list --limit 200 --filter-output 'members[].id,members[].name,members[].real_name,members[].profile.display_name,members[].deleted,members[].is_bot,response_metadata.next_cursor'`
  and match. The name people see in Slack is `profile.display_name`, or
  `real_name` when that is empty; `name` is the account's handle. Skip
  `deleted` and `is_bot` members.
- An id seen in a message: `slack users info --user U0123456789`.

## Search

`slack search messages '<query>'` (also `search files`, `search all`) takes
Slack's search syntax: `"exact phrase"`, `-word`, `in:#channel`,
`from:@name`, `with:@name`, `before:`/`after:`/`on:` a date,
`during:august`, `is:thread`, `has:pin`, `has::eyes:`. Results are in
`messages.matches[]`, each with a `permalink`; page with `--page` up to
`messages.paging.pages`. Search sees only what the signed-in person can see.

## A date range

A `ts` is Unix seconds with microseconds (`1789757627.925439`).
`slack conversations history <channel>` takes `--oldest` and `--latest` as
`ts` values and returns the newest messages first. Convert a date with
`date -j -f %Y-%m-%d 2026-09-01 +%s` (macOS) or `date -d 2026-09-01 +%s`
(GNU).

## Slow history

In some workspaces Slack limits this app's `conversations history` and
`conversations replies` to 15 messages per call and about one call per minute.
Follow the cursor, and on exit 3 wait as the error says.
