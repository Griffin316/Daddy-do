// Household helpers shared by the API routes.

// Members of a household, from the accounts table. Names are how Do's refer to people.
export async function getMembers(db, hh) {
  const { results } = await db.prepare('SELECT id, name, role FROM users WHERE household_id = ? ORDER BY id').bind(hh).all();
  return results;
}

// A new household gets the default weekly capacity and starter rewards.
export async function createHousehold(db) {
  const h = await db.prepare('INSERT INTO households DEFAULT VALUES RETURNING id').first();
  const R = [
    ['Sleep in on Saturday', 150, '😴'],
    ["Pick tonight's takeout", 100, '🍕'],
    ['Uninterrupted game / hobby night', 300, '🎮'],
    ['Afternoon off (golf, fishing, whatever)', 600, '⛳'],
  ];
  await db.batch([
    db.prepare("INSERT INTO settings (household_id, key, value) VALUES (?, 'capacity_min', '240')").bind(h.id),
    ...R.map(([t, c, e]) => db.prepare('INSERT INTO rewards (household_id, title, cost, emoji) VALUES (?, ?, ?, ?)').bind(h.id, t, c, e)),
  ]);
  return h.id;
}

export async function getSetting(db, hh, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE household_id = ? AND key = ?').bind(hh, key).first();
  return row ? row.value : null;
}

export async function getSettingsMap(db, hh) {
  const { results } = await db.prepare('SELECT key, value FROM settings WHERE household_id = ?').bind(hh).all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}
