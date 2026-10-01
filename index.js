require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, CLAIM_CHANNEL_ID, STAFF_ROLE_ID } = process.env;
for (const [key, value] of Object.entries({ DISCORD_TOKEN, CLIENT_ID, GUILD_ID, CLAIM_CHANNEL_ID, STAFF_ROLE_ID })) {
  if (!value) {
    console.error(`Missing ${key} — set it in .env locally, or in the service's Variables tab on Railway`);
    process.exit(1);
  }
}

// ---------- storage ----------
// data.json shape: { numbers: { "<number>": { claimedBy: userId | null, claimedAt: iso | null } } }
// On Railway, attach a Volume so data survives redeploys (Railway sets RAILWAY_VOLUME_MOUNT_PATH).
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { numbers: {} };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const data = loadData();

// Accepts "1, 2 3\n4" etc.
function parseNumbers(input) {
  return [...new Set(input.split(/[\s,]+/).map((n) => n.trim()).filter(Boolean))];
}

// ---------- commands ----------
const staffOnly = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim a number')
    .addStringOption((o) => o.setName('number').setDescription('The number to claim').setRequired(true)),

  new SlashCommandBuilder()
    .setName('addnumbers')
    .setDescription('Add numbers to the claim list (separate with spaces or commas)')
    .setDefaultMemberPermissions(staffOnly)
    .addStringOption((o) => o.setName('numbers').setDescription('e.g. 1, 2, 3').setRequired(true)),

  new SlashCommandBuilder()
    .setName('removenumbers')
    .setDescription('Remove numbers from the claim list')
    .setDefaultMemberPermissions(staffOnly)
    .addStringOption((o) => o.setName('numbers').setDescription('e.g. 1, 2, 3').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unclaim')
    .setDescription('Make a claimed number available again')
    .setDefaultMemberPermissions(staffOnly)
    .addStringOption((o) => o.setName('number').setDescription('The number to unclaim').setRequired(true)),

  new SlashCommandBuilder()
    .setName('listnumbers')
    .setDescription('Show all numbers and who claimed them')
    .setDefaultMemberPermissions(staffOnly),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`Registered ${commands.length} slash commands`);
}

// ---------- handlers ----------
const ephemeral = MessageFlags.Ephemeral;

async function handleClaim(interaction) {
  const number = interaction.options.getString('number').trim();
  const entry = data.numbers[number];

  if (!entry) {
    return interaction.reply({ content: `❌ **${number}** isn't on the list.`, flags: ephemeral });
  }
  if (entry.claimedBy) {
    return interaction.reply({ content: `❌ **${number}** has already been claimed.`, flags: ephemeral });
  }

  const channel = await interaction.client.channels.fetch(CLAIM_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error('CLAIM_CHANNEL_ID is not a text channel the bot can see');
    return interaction.reply({ content: '⚠️ Bot is misconfigured — tell staff.', flags: ephemeral });
  }

  entry.claimedBy = interaction.user.id;
  entry.claimedAt = new Date().toISOString();
  saveData();

  const embed = new EmbedBuilder()
    .setTitle('New Claim')
    .setColor(0x57f287)
    .addFields(
      { name: 'Number', value: number, inline: true },
      { name: 'Claimed by', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
    )
    .setTimestamp();

  await channel.send({
    content: `<@&${STAFF_ROLE_ID}>`,
    embeds: [embed],
    allowedMentions: { roles: [STAFF_ROLE_ID] },
  });

  return interaction.reply({ content: `✅ You claimed **${number}**! Staff have been notified.`, flags: ephemeral });
}

async function handleAdd(interaction) {
  const nums = parseNumbers(interaction.options.getString('numbers'));
  const added = [];
  const skipped = [];
  for (const n of nums) {
    if (data.numbers[n]) skipped.push(n);
    else {
      data.numbers[n] = { claimedBy: null, claimedAt: null };
      added.push(n);
    }
  }
  saveData();

  let msg = `✅ Added ${added.length} number(s).`;
  if (skipped.length) msg += `\nAlready on list: ${skipped.join(', ')}`;
  return interaction.reply({ content: msg, flags: ephemeral });
}

async function handleRemove(interaction) {
  const nums = parseNumbers(interaction.options.getString('numbers'));
  const removed = nums.filter((n) => data.numbers[n]);
  removed.forEach((n) => delete data.numbers[n]);
  saveData();

  const missing = nums.filter((n) => !removed.includes(n));
  let msg = `🗑️ Removed ${removed.length} number(s).`;
  if (missing.length) msg += `\nNot on list: ${missing.join(', ')}`;
  return interaction.reply({ content: msg, flags: ephemeral });
}

async function handleUnclaim(interaction) {
  const number = interaction.options.getString('number').trim();
  const entry = data.numbers[number];
  if (!entry) return interaction.reply({ content: `❌ **${number}** isn't on the list.`, flags: ephemeral });
  if (!entry.claimedBy) return interaction.reply({ content: `**${number}** isn't claimed.`, flags: ephemeral });

  entry.claimedBy = null;
  entry.claimedAt = null;
  saveData();
  return interaction.reply({ content: `🔓 **${number}** is available again.`, flags: ephemeral });
}

async function handleList(interaction) {
  const entries = Object.entries(data.numbers);
  if (!entries.length) return interaction.reply({ content: 'The list is empty.', flags: ephemeral });

  const lines = entries.map(([n, e]) => (e.claimedBy ? `~~${n}~~ — <@${e.claimedBy}>` : `**${n}** — available`));
  const available = entries.filter(([, e]) => !e.claimedBy).length;

  // Embed descriptions max out at 4096 chars
  let description = lines.join('\n');
  if (description.length > 4000) description = description.slice(0, 4000) + '\n…';

  const embed = new EmbedBuilder()
    .setTitle(`Numbers (${available}/${entries.length} available)`)
    .setDescription(description)
    .setColor(0x5865f2);
  return interaction.reply({ embeds: [embed], flags: ephemeral, allowedMentions: { parse: [] } });
}

const handlers = {
  claim: handleClaim,
  addnumbers: handleAdd,
  removenumbers: handleRemove,
  unclaim: handleUnclaim,
  listnumbers: handleList,
};

// ---------- client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', (c) => console.log(`Logged in as ${c.user.tag}`));

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const handler = handlers[interaction.commandName];
  if (!handler) return;
  try {
    await handler(interaction);
  } catch (err) {
    console.error(err);
    const reply = { content: '⚠️ Something went wrong.', flags: ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

registerCommands()
  .then(() => client.login(DISCORD_TOKEN))
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
