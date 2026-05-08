import {
  world,
  system,
  EntityQueryOptions,
  EntityQueryPropertyOptions,
} from '@minecraft/server';

import { Config } from 'system/config.js';

export function getPlayersCaidos() {
  const dimensions = ['overworld', 'nether', 'the_end'];

  let players_caidos = [];

  for (const dimension of dimensions) {
    const players = world
      .getDimension(dimension)
      .getPlayers({ tags: [Config.tag_down] });

    players_caidos.push(...players);
  }

  return players_caidos;
}
