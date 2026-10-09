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
export const BLOB_AGGRO = 5.5; // start chasing (needs line of sight unless very close)
export const BLOB_DEAGGRO = 10; // hysteresis: keep chasing until the player is this far
export const BLOB_LEASH = 18; // never chase further than this from home
export const BLOB_GIVEUP = 5.5; // seconds of no progress / no path before walking home
export const BLOB_REAGGRO_CD = 3;
export const BLOB_RESPAWN = 20;
export const CONTACT_COOLDOWN = 1.0;

export const BOSS_R = 0.95;
export const BOSS_HP = 8;
export const BOSS_SPEED = 3.6; // enraged (≤ half HP): ×1.15
export const BOSS_CONTACT_DMG = 1; // half-heart for bumping into him
export const BOSS_LUNGE_DMG = 2; // a full heart for eating a lunge
export const BOSS_WINDUP = 0.8; // crouch, glow ramp, charge sfx, ground lane fills
export const BOSS_WINDUP_ENRAGED = 0.65;
export const BOSS_LUNGE_SPEED = 11;
export const BOSS_LUNGE_TIME = 0.5;
/** Lunge reach = speed × time (5.5 tiles); the ground lane telegraph is drawn exactly this long. */
export const BOSS_LUNGE_DIST = BOSS_LUNGE_SPEED * BOSS_LUNGE_TIME;
export const BOSS_LUNGE_RANGE = 7;
export const BOSS_AIM_LOCK = 0.3; // last part of the windup: heading is locked, so a sidestep dodges
export const BOSS_STUN_MAX_HITS = 2; // he shakes off the daze after two hits
export const BOSS_STUN = 1.5; // dizzy window after every lunge
export const BOSS_BONK_STUN = 1.9; // lunging into a wall dazes him longer
export const BOSS_LUNGE_CD = 1.0; // after stun → chase before he may lunge again
export const BOSS_GUARD = 2.5; // after a glancing (non-stun) hit: guarded + counter-lunge
export const BOSS_COUNTER_WINDUP = 0.6;
export const BOSS_SPIT_WINDUP = 0.6;
export const BOSS_SPIT_CD = 4.5;
export const GLOB_FLIGHT = 1.1;
/**
 * Globs land, then sit on a FUSE before bursting. The hero is hit if their centre is within
 * GLOB_SPLASH_R + PLAYER_R/2 (= 1.31 tiles) of the glob. From a standstill at the centre the
 * hero needs ~0.32s to clear that (0.137s to reach 5.2 t/s at 38 t/s², then cruise), so with a
 * 0.3s reaction they're out at ~0.62s — inside the 0.8s fuse with ~0.18s to spare.
 */
export const GLOB_FUSE = 0.8;
export const GLOB_SPLASH_R = 1.15;
export const GLOB_DMG = 1;
export const PUDDLE_R = 0.85;
export const PUDDLE_LIFE = 1.6;

/** Spawn sanctuary: enemies never enter and never aggro on a player inside it. */
export const SAFE_RADIUS = 6.5;

export const PICKUP_LIFE = 18;
export const MAGNET_RADIUS = 1.9;
