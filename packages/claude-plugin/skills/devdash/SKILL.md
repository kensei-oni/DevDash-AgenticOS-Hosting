---
name: devdash
description: How to work inside DevDash, the team's server - tasks, notes, services and commits. Use whenever you work on a DevDash task, start or stop servers or containers, or when the user mentions tasks, notes, the board or services.
---

# Working in DevDash

You run on a shared DevDash server that the team uses from their phones and PCs. The DevDash tools (`project_info`, `tasks_*`, `task_*`, `notes_*`, `note_*`, `services_list`) act as the person you work for; changes show up as "via Claude".

## Tasks
- Starting work on a task: `task_update` it to `in_progress` (and `assign_to_me` if nobody has it).
- Finished: commit with `fixes #N` (N = the task number) in the message. DevDash moves the task to **Review** when that commit lands on a branch and to **Done** when it reaches the default branch. Don't mark it done yourself unless asked.
- Then `task_comment` a short summary: what changed, how to test it, anything left open.
- Found more work? `task_create` it rather than burying it in a comment. Task numbers are DevDash's own, not GitHub issue numbers.

## Notes
- Check `notes_list` for setup steps and decisions before guessing. Record durable decisions, setup steps and gotchas with `note_upsert` (pinned for the important ones). Never put secrets in notes.

## Services (servers, containers)
- Anything long-running goes through `devdash service add <name> --cmd '…'` in Bash, never a foreground or background Bash process. It gets its own `$PORT`; bind to 127.0.0.1.
- Look first: `services_list` / `devdash service ls` and `devdash service ports`. Reuse what's running.

## Hosting on the internet (agOS Hosting, Dokploy)
- For something that should be public on its own domain (a site, an API, a compose stack), use the hosting tools, not `devdash service add` (that's for dev servers on this machine).
- `hosting_status` first: if it isn't configured, tell the person to finish the setup on the Hosting page. `hosting_list` to reuse what's there.
- `hosting_create` with a pushed `git_url` (and `port` the app listens on), a `docker_image` or a `compose_file`. Then poll `hosting_get` until the latest deployment is `done`; on `error` read `hosting_logs`, fix, push and `hosting_action` `redeploy`. Finish with the public URL.
- Never delete without asking; only admins can.

## Branches
- If this session runs in a worktree (`/srv/devdash/worktrees/...`), you're on your own `dd/…` branch: commit there; the person merges or opens a PR.

## Deploying DevDash itself (only when `devdash_deploy_request` is available)
- You can't deploy directly (no sudo, no root SSH) and shouldn't look for a way around that. When the person wants your work live: commit, push to main, then `devdash_deploy_request` with a one-line note. An admin approves on the Server page; the server builds, restarts and rolls back on its own if the new version is unhealthy.
- `devdash_deploy_status` shows what's live, what's waiting and how the last deploy went (with its output if it failed).

## Team roles (only when `team_message` is available)
- The project has AI team members (CEO, Marketing…). If you notice a real product or business signal (money, users, metrics, a broken release, store reviews), tell the right role with `team_message`, with the numbers as evidence. Rarely, and never for code details: the journal already tells them what you worked on.
- Create or change roles (`team_role_create`, `team_role_update`) only when the person asks. Show them what you set up.
