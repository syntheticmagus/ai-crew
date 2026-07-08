import { Role, ALL_ROLES } from '../config/types'

// ── Wordlists ──────────────────────────────────────────────────────────────────

const TEAM_ADJECTIVES = [
  'Affable', 'Agile', 'Amber', 'Astral', 'Azure', 'Blazing', 'Bold', 'Brilliant',
  'Cerulean', 'Cobalt', 'Crimson', 'Daring', 'Deft', 'Dynamic', 'Earnest', 'Emerald',
  'Fleet', 'Gilded', 'Gleaming', 'Golden', 'Infinite', 'Ivory', 'Jade', 'Kinetic',
  'Lateral', 'Liminal', 'Lucent', 'Luminous', 'Nimble', 'Oblique', 'Obsidian', 'Onyx',
  'Opal', 'Orbital', 'Prismatic', 'Radiant', 'Ruby', 'Sapphire', 'Scarlet', 'Serene',
  'Silver', 'Stalwart', 'Stellar', 'Swift', 'Tenacious', 'Topaz', 'Valiant', 'Verdant',
  'Vibrant', 'Vivid', 'Zenith', 'Zephyr',
]

const TEAM_NOUNS = [
  'Agency', 'Alliance', 'Assembly', 'Bureau', 'Circuits', 'Co', 'Collective',
  'Consortium', 'Crew', 'Depot', 'Division', 'Dynamics', 'Engine', 'Factory',
  'Fleet', 'Forge', 'Foundry', 'Group', 'Guild', 'Hub', 'Institute', 'Junction',
  'Labs', 'Network', 'Nexus', 'Node', 'Operations', 'Outpost', 'Partners',
  'Platform', 'Press', 'Protocol', 'Relay', 'Signal', 'Solutions', 'Sparks',
  'Station', 'Studio', 'Syndicate', 'Systems', 'Tactics', 'Technologies',
  'Terminal', 'Unit', 'Vault', 'Ventures', 'Workshop', 'Works',
]

const AGENT_FIRST_NAMES = [
  'Ada', 'Alex', 'Alexis', 'Ali', 'Alicia', 'Amber', 'Amy', 'Aria', 'Ash', 'Ashley',
  'Bailey', 'Ben', 'Blake', 'Brandon', 'Brooke', 'Cameron', 'Casey', 'Charlie',
  'Chelsea', 'Chris', 'Claire', 'Dana', 'Dani', 'Daniel', 'David', 'Dylan',
  'Elena', 'Eli', 'Elliott', 'Emma', 'Evan', 'Fiona', 'Flynn', 'Gary', 'Grace',
  'Harper', 'Hayden', 'Hunter', 'Iris', 'Jack', 'Jamie', 'Jane', 'Jason', 'Jay',
  'Jesse', 'Jordan', 'Jules', 'Kai', 'Kate', 'Lena', 'Leo', 'Lily', 'Logan',
  'Luna', 'Marcus', 'Maya', 'Max', 'Mia', 'Morgan', 'Nadia', 'Nathan', 'Noah',
  'Nora', 'Nova', 'Oliver', 'Owen', 'Paige', 'Parker', 'Percy', 'Priya', 'Quinn',
  'Rachel', 'Reagan', 'Reed', 'Reese', 'Riley', 'River', 'Robin', 'Rosa', 'Ryan',
  'Sam', 'Sara', 'Scott', 'Serena', 'Shane', 'Sierra', 'Sofia', 'Stella', 'Sydney',
  'Taylor', 'Theo', 'Tess', 'Uma', 'Val', 'Vera', 'Victor', 'Wade', 'Wren', 'Zoe',
]

// ── Generator ──────────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

/** Fisher-Yates shuffle, returns a new array. */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * Generate a unique team identity for this deployment.
 * Called once at bootstrap; results are persisted to .tokens.json so they
 * stay stable across restarts.
 */
export function generateIdentity(roles: Role[]): {
  teamName: string
  agentNames: Record<Role, string>
} {
  const teamName = `${pick(TEAM_ADJECTIVES)} ${pick(TEAM_NOUNS)}`

  // Sample without replacement so no two agents share a name within a team.
  const names = shuffle(AGENT_FIRST_NAMES)
  const agentNames = {} as Record<Role, string>
  roles.forEach((role, i) => {
    agentNames[role] = names[i % names.length]!
  })

  return { teamName, agentNames }
}

// Re-export so callers can use ALL_ROLES without a separate import.
export { ALL_ROLES }
