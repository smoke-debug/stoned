================================================================
  Discord Bot — Premium Package v7
  UwUify · VoiceMaster · VC Milestone Roles · Smoke Bucks
  Economy · Gambling · Daily Quests · Welcome DM
================================================================

QUICK START
-----------
1. Create a Discord application at https://discord.com/developers/applications
2. Go to Bot → Add Bot → copy the token
3. Under Bot → Privileged Gateway Intents, enable:
     - Server Members Intent
     - Message Content Intent
     - Presence Intent            ← REQUIRED for Status Roles feature
4. Under OAuth2 → URL Generator, select scopes:
     bot + applications.commands
   And bot permissions:
     Manage Channels, Manage Messages, Manage Webhooks,
     Move Members, Send Messages, Embed Links,
     Read Message History, View Channels, Manage Roles
5. Use the generated URL to invite the bot to your server
6. Set DISCORD_TOKEN in your environment (see env.example)
7. Run:  npm install  then  npm start

================================================================
  RAILWAY DEPLOYMENT
================================================================
1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add a variable:  DISCORD_TOKEN = your-bot-token
4. Railway will auto-detect package.json and run npm start
5. Add any optional variables from env.example as needed

================================================================
  FEATURES & COMMANDS  (default prefix: *)
================================================================

---- UWUIFY -------------------------------------------------------
*uwuify @user       Start uwuifying a user's messages
*unuwuify @user     Stop uwuifying a user
*uwulist            List all currently uwuified users  (requires Manage Messages)

Requires: Manage Messages, Manage Server, or Administrator
The bot replaces messages via webhook, preserving the user's
avatar and display name. Attachments are forwarded.

---- VOICEMASTER --------------------------------------------------
*vm setup           Create all VC categories and join channels

*vc lock            Lock your VC (move to private category)
*vc unlock          Unlock your VC (move to public category)
*vc hide            Hide your VC from everyone
*vc unhide          Show your VC again
*vc permit @user    Allow a specific user to join
*vc reject @user    Block and disconnect a specific user
*vc transfer @user  Give VC ownership to someone else
*vc limit 5         Set a user cap (0 = no limit)
*vc rename name     Rename your VC
*vc bitrate 96      Set bitrate in kbps
*vc claim           Claim an abandoned VC
*vc info            Show VC details

How it works:
- Joining "Join Public VC"  → creates a personal public temp VC
- Joining "Join Private VC" → creates a personal private temp VC
- Joining "Random Public VC"→ drops you into a random active VC
- Empty temp VCs are deleted automatically
- Text inside temp VCs is blocked (only bot controls are shown)

---- VC MILESTONE ROLES -------------------------------------------
*vcm                  Show all configured milestones
*vcm list             Same as above
*vcm add @Role 24h    Add a milestone (role granted at threshold)
*vcm remove <# or @>  Remove a milestone by number or role mention
*vcm check            Check your own VC time and progress
*vcm check @user      Check another user's VC time and progress
*vcm lb               VC time leaderboard (top 10)
*vcm setchannel #ch   Post an announcement when a role is earned
*vcm clearchannel     Disable announcements (grant roles silently)
*vcm reset @user      Reset a user's VC time to 0 (admin)
*vcm settime @user 48h Manually set VC time and re-check milestones

Time formats:
  24h · 7d · 90m · 1h30m · 2d12h · bare number = minutes

How it works:
- Total VC time is tracked per user per guild, saved to disk
- Time is flushed precisely on leave; also saved every 60s
  (so at most 60s is lost if the bot crashes mid-session)
- On restart, users already in VC are picked up automatically
- Roles are granted the moment a threshold is crossed
- Multiple milestones can be set (up to 25 per server)
- Already-granted milestones are never double-granted
- Deleted milestone roles are skipped silently

Requires Manage Server for: add, remove, setchannel,
clearchannel, reset, settime

---- ECONOMY ------------------------------------------------------
*balance [@user]    Check balance, total earned, win/loss stats
*bal [@user]        Alias for balance
*daily              Claim daily reward (+streak bonus up to 2,500)
*work               Earn Smoke Bucks (15 min cooldown)
*beg                Small random payout (5 min cooldown)
*donate @user amt   Send Smoke Bucks (daily cap enforced)
*pay @user amt      Alias for donate
*leaderboard        Top 10 balances
*lb                 Alias for leaderboard

Amount supports: a number, "half", or "all"

---- GAMBLING GAMES -----------------------------------------------
*coinflip amt heads/tails    50/50 animated coin flip
*slots amt                   3-reel slot machine
                               - Pair: 1.5x
                               - Three of a kind: 5x
                               - Triple 7s: 10x
*dice amt over/under         Roll 1-100, pick over or under 50
*roulette amt red/black/green
                               - Red / Black: 1x payout
                               - Green: 14x payout
*blackjack amt               Interactive hit/stand with animated
*bj amt                        deal. 90s timeout per game.
*ttt @user [amt]             Tic-Tac-Toe vs another user.
                               Challenge/accept flow. Button board.
                               3-minute game timeout. Bet optional.

---- DAILY QUESTS -------------------------------------------------
*quests             Show today's missions with progress bars
*missions           Alias for quests

Quest types include: chatting, VC time, playing/winning games,
using daily/work, donating, wagering totals.

Regular members: 3 quests/day
Server boosters:  5 quests/day
Rewards are auto-paid and announced on completion.
Resets daily at midnight in QUEST_RESET_TZ timezone.

---- WELCOME DM ---------------------------------------------------
*wdm                Show current Welcome DM config
*wdm enable         Enable join DMs
*wdm disable        Disable join DMs
*wdm message <text> Set a plain-text DM message
*wdm test           Send yourself a test DM
*wdm preview        Preview the DM in the current channel
*wdm reset          Wipe entire Welcome DM config

Embed subcommands:
*wdm embed title <text>
*wdm embed desc <text>
*wdm embed color <hex>         e.g. ff8a00
*wdm embed thumbnail <url>
*wdm embed image <url>
*wdm embed footer <text>
*wdm embed addfield <name> | <value>
*wdm embed addfield <name> | <value> | inline
*wdm embed removefield <number>
*wdm embed clearfields
*wdm embed clear

Supported variables (resolved at send time):
  {user.mention}        {user.username}     {user.globalName}
  {user.displayName}    {user.tag}          {user.id}
  {user.createdAt}      {server.name}       {server.memberCount}
  {server.id}           {server.icon}

---- FRIEND GROUPS (slash command) ----------------------------------------
/friendgroup create name:Crew members:@user1 @user2 @user3 ...
  Creates a friend group AND a server role with the same name.
  Mention as many members as you want in the members field,
  separated by spaces. No limit on how many you can add.
  Optional: color hex for the role (e.g.  color:ff8a00)

/friendgroup add name:Crew members:@user1 @user2 ...
  Add any number of members to an existing group and assign
  them the group role. Mentions separated by spaces.

/friendgroup remove name:Crew members:@user1 @user2 ...
  Remove any number of members from the group and take the
  role away. Mentions separated by spaces.

/friendgroup delete name:Crew
  Delete the group and remove the role from the server entirely.

/friendgroup stats name:Crew
  Show a live stats embed for the group:
  - Total messages across all members
  - Total voice time across all members
  - Per-member breakdown: messages + VC hours, ranked by messages
  - 🔴 indicator for members currently in a voice channel
  - 🔄 Refresh Stats button to pull current data at any time

/friendgroup list
  List all friend groups with member counts and roles.

How stats work:
- Messages use the same auto-tracked message counter as giveaway
  requirements — buffered in memory, flushed to disk every 60s,
  and the live in-memory buffer is included for instant accuracy.
- VC time uses the existing VC Milestone tracking system —
  includes live in-session time so a user currently in VC shows
  their real accumulated time without waiting for them to leave.
- Stats always reflect the current moment; clicking 🔄 Refresh
  pulls fresh numbers without leaving the message.

Autocomplete: the `name` field autocompletes from existing groups.

Permissions:
  - create / add / remove / delete: Manage Server
  - stats / list: anyone

---- MOD WALLET ---------------------------------------------------
*mw / *modwallet       Show your own mod wallet (alias: *mw check)

PUBLIC:
*mw check [@user]      View your or another user's mod wallet
*mw lb                 Leaderboard — top 10 by credit balance

EDITOR (whitelisted users OR Manage Server):
*mw add @user <n> [reason]     Add credits
*mw deduct @user <n> [reason]  Deduct credits (won't go below 0)
*mw set @user <n> [reason]     Set balance to exact amount
*mw reset @user [reason]       Reset balance to 0

ADMIN (Manage Server only):
*mw whitelist add @user        Grant someone edit access
*mw whitelist remove @user     Revoke edit access
*mw whitelist list             View all whitelisted editors

Wallet embed shows:
  - Current balance
  - Credits earned in last 24h / 7d / 30d / all time
  - Last 5 transactions with reason, who made the change, and
    Discord relative timestamp

Notes:
  - History is capped at 500 entries per user
  - "All time earned" only counts additions, not the current balance
  - Deducting more than someone's balance quietly caps at 0
  - Reasons are optional but recommended for audit purposes

---- GIVEAWAYS (slash command) --------------------------------------------
/giveaway create       Create a new giveaway
  channel: #channel    Where to post it
  prize: Nitro         What you're giving away
  duration: 24h        How long to run (30m, 1h, 7d, etc.)
  winners: 1           Number of winners (optional, default 1)
  description: ...     Extra info shown in the embed (optional)
  status_required: /pmo  Substring users must have in their status (optional)
  min_messages: 50     Messages user must send after clicking Enter (optional)
  min_vc_hours: 2      VC hours user must spend after clicking Enter (optional)

/giveaway end <id>     End a giveaway early and draw winners
/giveaway reroll <id>  Reroll winners from an ended giveaway
/giveaway list         List all active giveaways
/giveaway cancel <id>  Cancel without drawing winners

Requirements system:
- Status: checked in real-time against the user's custom Discord status
- Messages: tracked automatically as users chat; flushed to DB every 60s
  and also includes live in-memory count for instant feedback
- VC hours: uses the same live VC tracking as VC Milestone Roles —
  includes current session time so progress is visible immediately
- Snapshot is taken when a user FIRST clicks Enter (baseline for progress)
- Users see their exact progress and what is still needed if rejected
- Once entered, entry is permanent (no re-checking after joining)

Persistence:
- Giveaways are saved to bot-data.json and survive bot restarts
- On startup, all active giveaways are rescheduled automatically
- The 60s tick also checks for any giveaways that expired during downtime

Requires: Manage Server for create/end/reroll/cancel (list is public)

---- STATUS ROLES (slash command) ---------------------------------
/statusrole add        Add a new rule
  substrings: /pmo     Text the status must contain (comma-separated
                       for AND logic, e.g.  /pmo,sponsored)
  role1: @RoleName     Role to grant when status matches
  role2: @RoleName     Optional second role
  role3: @RoleName     Optional third role

/statusrole remove <n> Remove rule #n from the list
/statusrole list       Show all configured rules
/statusrole check [@u] Preview which rules match a user right now

How it works:
- The bot watches every member's custom status in real time via the
  Discord Presence gateway (requires Presence Intent enabled in the
  Developer Portal — see step 3 of Quick Start above).
- When a status MATCHES all substrings in a rule, the rule's roles
  are immediately granted.
- When a status NO LONGER matches, the roles are revoked.
- Multiple substrings in one rule = AND logic (all must be present).
- Multiple rules can each grant the same or different roles.
- A role shared by multiple rules is only revoked when NO matching
  rule grants it, so overlapping rules work correctly.
- On bot startup, all currently-online members are re-evaluated so
  no one is missed during downtime.
- When a rule is added, currently-online matching members get the
  roles immediately without needing to toggle their status.
- When a rule is removed, online members are re-evaluated and roles
  are revoked if no other rule still grants them.
- Slash commands are registered per-guild on startup (instant — no
  1-hour global propagation delay).

Requires: Manage Server (enforced both by Discord and the bot)

---- GHOST PING ON JOIN -------------------------------------------
*ghostping            Show config and channel list
*gp                   Alias for ghostping
*ghostping enable     Start ghost pinging new members
*ghostping disable    Stop ghost pinging
*ghostping add #ch    Add a channel (can mention multiple at once)
*ghostping remove #ch Remove a channel (or use list number)
*ghostping clear      Remove all channels

How it works:
- When a member joins, the bot sends a ping in every configured
  channel then immediately deletes it.
- The member gets a notification badge but sees no message.
- Multiple channels supported (up to as many as you like).
- Auto-disables if all channels are removed.
- Runs alongside Welcome DM independently.

Requires: Manage Server for all subcommands

---- MODERATION ---------------------------------------------------
*purge <1-100>      Bulk delete messages (max 14 days old)

Requires: Manage Messages or Administrator

---- GENERAL ------------------------------------------------------
*help               Show all command categories

================================================================
  DATA STORAGE
================================================================
All data is saved to bot-data.json in the working directory.
Back this file up if you want to preserve economy/VC data.
On Railway, data resets on each redeploy unless you mount
a persistent volume or use a database add-on.

To use a custom path:  DATA_FILE=/data/bot-data.json

================================================================
  BOT PERMISSIONS REQUIRED
================================================================
- Manage Roles       (VC milestone role grants + Status Role grants)
- Manage Channels    (VoiceMaster create/delete temp VCs)
- Manage Messages    (UwUify delete + purge command)
- Manage Webhooks    (UwUify webhook impersonation)
- Move Members       (VoiceMaster move users to temp VCs)
- Send Messages      (all responses)
- Embed Links        (all embed responses)
- Read Message History (purge + VC embeds)
- View Channels      (general access)

Make sure the bot's role is ABOVE any roles it needs to assign
in the server's role hierarchy, or milestone grants will fail.

================================================================
  PACKAGE VERSION
================================================================
Name:    premium-disco-v11
Runtime: Node.js >= 20
Library: discord.js ^14.19.3
