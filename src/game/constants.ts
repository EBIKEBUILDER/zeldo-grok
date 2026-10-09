export const DT = 1 / 60;

// Tile size is 1 world unit. Map coordinates: x → east (screen right), y → south (screen down).
export const SCREEN_W = 16;
export const SCREEN_H = 12;
export const SCREENS_X = 3;
export const SCREENS_Y = 2;
export const OVER_W = SCREEN_W * SCREENS_X; // 48
export const OVER_H = SCREEN_H * SCREENS_Y; // 24

export const PLAYER_R = 0.32;
export const PLAYER_MAX_SPEED = 5.2;
export const PLAYER_ACCEL = 38;
export const PLAYER_DECEL = 30;
export const PLAYER_MAX_HP = 6; // half-hearts → 3 hearts
export const INVULN_TIME = 1.1;

export const SWING_TIME = 0.24;
export const SWING_COOLDOWN = 0.38;
export const SWING_REACH = 1.35;
export const SWING_HALF_ARC = (80 * Math.PI) / 180;

export const BLOB_R = 0.4;
export const BLOB_HP = 2;
export const BLOB_SPEED = 2.1;
export const BLOB_AGGRO = 5.5;
export const BLOB_RESPAWN = 20;
export const CONTACT_COOLDOWN = 1.0;

export const BOSS_R = 0.95;
export const BOSS_HP = 8;
export const BOSS_SPEED = 2.9;

/** Spawn sanctuary: enemies never enter and never aggro on a player inside it. */
export const SAFE_RADIUS = 6.5;

export const PICKUP_LIFE = 18;
export const MAGNET_RADIUS = 1.9;
