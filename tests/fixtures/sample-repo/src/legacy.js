const path = require('path');
const { greet } = require('./greet.js');

async function lazy() {
  const mod = await import('./math/add.js');
  return mod.add(1, 2);
}

module.exports = { lazy, join: path.join, greet };
