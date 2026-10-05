/**
 * Passed directly to chrome.scripting.executeScript({ func, world: 'ISOLATED' }).
 * Keep every dependency inside the function: only fixed same-origin GET requests
 * run in the official tab. Account IDs, profiles and credentials never leave it.
 */
export async function readActivePartyContext() {
  const unavailable = () => ({ error: 'PARTY_CONTEXT_UNAVAILABLE' });
  try {
    const startingUrl = new URL(location.href);
    const route = /^\/(?:ja\/)?party\/lobby\/([A-Za-z0-9_-]{1,128})\/?$/.exec(startingUrl.pathname);
    if (startingUrl.origin !== 'https://www.geoguessr.com' || startingUrl.username || startingUrl.password || !route) {
      return unavailable();
    }

    // One deadline for all reads. Cookies are used by the tab's fetch only.
    const signal = AbortSignal.timeout(8000);
    const read = async path => {
      const response = await fetch(path, {
        method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal,
      });
      if (!response.ok || response.redirected ||
          !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        throw new Error('PARTY_CONTEXT_UNAVAILABLE');
      }
      return response.json();
    };
    const [party, profile, memberInfo] = await Promise.all([
      read('/api/v4/parties/v2/active'),
      read('/api/v3/profiles/'),
      read('/api/v4/parties/v2/members?page=0&count=101'),
    ]);

    const currentUrl = new URL(location.href);
    if (currentUrl.origin !== startingUrl.origin || currentUrl.pathname !== startingUrl.pathname ||
        currentUrl.username || currentUrl.password) return unavailable();

    const settings = party?.partySettings;
    const partyCode = party?.joinCode?.code;
    const ownerId = party?.owner?.userId;
    // Official account adapter390249 uses raw user.id || user.userId.
    const currentUserId = profile?.user?.id || profile?.user?.userId;
    const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
    const validCount = value => Number.isSafeInteger(value) && value >= 0;
    if (!validId(party?.partyId) || !validId(ownerId) || !validId(currentUserId) ||
        typeof partyCode !== 'string' || !/^[A-Za-z0-9]{5}$/.test(partyCode) ||
        typeof party?.gameType !== 'string' || !party.gameType || party.gameType.length > 64 ||
        !['NoGame', 'Ongoing', 'Finished'].includes(party?.gameState) ||
        typeof settings?.allowGuests !== 'boolean' || typeof settings?.masterControl !== 'boolean' ||
        !validCount(settings?.maxPartySize) || settings.maxPartySize < 1 ||
        !Array.isArray(memberInfo?.members) || !validCount(memberInfo?.totalCount) ||
        memberInfo.totalCount > 101 || memberInfo.members.length !== memberInfo.totalCount) {
      return unavailable();
    }
    if (route[1] !== party.partyId && route[1].toUpperCase() !== partyCode.toUpperCase()) return unavailable();
    if (memberInfo.partyId !== undefined && memberInfo.partyId !== party.partyId) return unavailable();

    const members = memberInfo.members;
    if (members.some(member => !validId(member?.userId)) ||
        new Set(members.map(member => member.userId)).size !== members.length ||
        !members.some(member => member.userId === ownerId)) return unavailable();

    // Leave other official Party modes to their normal controls. This sentinel
    // is emitted only after verifying the tab, Party, account and member data.
    if (!['Duels', 'TeamDuels'].includes(party.gameType)) return { error: 'UNSUPPORTED_GAME_TYPE' };

    // Official606207: Duels2; TeamDuels20, or101 in all-against-one
    // when maxPartySize===101 and the owner is not a game master.
    const capacity = party.gameType === 'Duels' ? 2
      : settings.maxPartySize === 101 && !settings.masterControl ? 101 : 20;
    // Official226896.GO selects in member order, excluding a game-master owner.
    // Raw isBenched may be missing; this is a prediction, not game membership.
    const eligibleCount = members.filter(member => !settings.masterControl || member.userId !== ownerId).length;
    return {
      partyCode: partyCode.toUpperCase(),
      isLeader: currentUserId === ownerId,
      gameState: party.gameState,
      guestsAllowed: settings.allowGuests,
      capacity,
      memberCount: memberInfo.totalCount,
      participatingCount: Math.min(capacity, eligibleCount),
      roomCapacity: settings.maxPartySize,
      observedAt: Date.now(),
    };
  } catch {
    // Never expose server bodies, profile data, account IDs or exception text.
    return unavailable();
  }
}
