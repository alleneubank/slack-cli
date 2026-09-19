# Files

## Upload and share a file

`slack files upload` no longer works (Slack retired `files.upload`; it fails
with `method_deprecated`), and its `--file` flag takes text, not a path.
Upload in three steps. Step 2 is a plain HTTP POST to Slack's file host, is the
one step outside the CLI, and needs no token:

```sh
bytes=$(wc -c < report.png | tr -d ' ')
slack files getUploadURLExternal --filename report.png --length "$bytes" --json
# -> upload_url, file_id
curl -sS --data-binary @report.png "$upload_url"
# -> HTTP 200, body "OK - <bytes>"
slack files completeUploadExternal --files '[{"id":"F0123456789","title":"Report"}]' \
  --channel_id C0123456789 --initial_comment 'Weekly report'
```

- `--length` is the file's exact size in bytes.
- `--thread_ts <parent ts>` shares it in a thread; `--channels C1,C2` shares it
  in several conversations. With neither `--channel_id` nor `--channels`, the
  file stays private to the signed-in person.
- Needs `files:write` (`slack login --write`). Steps 1 and 3 accept
  `--dry-run`.
- Deleting the file (`slack files delete --file F…`) leaves the message that
  shared it; delete that with `slack chat delete <channel> <ts>`.

## Read a file

- `slack files info <file>` returns the name, type, size, and `permalink`.
- The contents (`url_private`, `url_private_download`) need the token in an
  `Authorization` header, which the CLI never prints, so the CLI cannot
  download them. Give the user the `permalink` instead.
