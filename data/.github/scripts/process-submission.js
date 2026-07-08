// Runs via actions/github-script when a new Issue titled "[Song Submission] ..." is opened.
// Validates the submitted song JSON, checks for duplicates, strips any disallowed fields
// (defense in depth — the app itself never sends translation, but never trust the client),
// then commits the entry to data/fi.json via a PR and auto-merges on success.
//
// Globals available here (injected by actions/github-script): github, context, core.

const DATA_PATH = 'data/fi.json';
const BASE_BRANCH = 'main';
const MAX_JSON_BYTES = 64 * 1024; // just under GitHub's 65536-char issue body limit; catches corrupted payloads
const MIN_WORDS = 20;

// Small hardcoded wordlist — deliberately conservative (explicit slurs/profanity only).
// Matched as whole words, case-insensitive, against the title + all lyric lines.
const BANNED_WORDS = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'retard',
  'whore', 'slut', 'rape', 'paska', 'vittu', 'perkele', 'saatana', 'huora'
];

function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics for loose duplicate matching
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonBlock(body) {
  const fenced = body.match(/```json\s*([\s\S]*?)```/) || body.match(/```\s*([\s\S]*?)```/);
  if (!fenced) return null;
  try {
    return JSON.parse(fenced[1]);
  } catch (e) {
    return null;
  }
}

function validateStructure(song) {
  if (!song || typeof song !== 'object') throw new Error('Submission is not a valid object.');
  if (!song.title || typeof song.title !== 'string' || !song.title.trim())
    throw new Error('Missing song title.');
  if (!song.videoId || !/^[\w-]{6,15}$/.test(song.videoId))
    throw new Error('Missing or invalid YouTube video ID.');
  if (!Array.isArray(song.verses) || song.verses.length === 0)
    throw new Error('Song has no verses.');

  const allLineTexts = [];
  for (const verse of song.verses) {
    if (!verse || !Array.isArray(verse.lines) || verse.lines.length === 0)
      throw new Error('A verse is missing its lines.');
    for (const line of verse.lines) {
      if (!line || typeof line.text !== 'string' || !line.text.trim())
        throw new Error('A line is missing its text.');
      if (typeof line.start !== 'number' || typeof line.end !== 'number')
        throw new Error(`Line "${line.text.slice(0, 30)}" is missing timing (start/end).`);
      if (line.end <= line.start)
        throw new Error(`Line "${line.text.slice(0, 30)}" has invalid timing (end <= start).`);
      allLineTexts.push(line.text);
      if (line.verbs !== undefined) {
        if (!Array.isArray(line.verbs)) throw new Error('Malformed verb list on a line.');
        for (const vb of line.verbs) {
          if (!vb || !vb.surface || !vb.infinitive || !Array.isArray(vb.options) || vb.options.length === 0)
            throw new Error(`Malformed verb entry near "${line.text.slice(0, 30)}".`);
          if (!vb.options.some(o => o && o.form === vb.surface))
            throw new Error(`Verb "${vb.surface}" is missing from its own options list.`);
        }
      }
    }
  }

  const wordCount = allLineTexts.join(' ').trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS)
    throw new Error(`Lyrics are too short (${wordCount} words, minimum ${MIN_WORDS}).`);

  return allLineTexts;
}

function checkProfanity(song, allLineTexts) {
  const haystack = normalizeForMatch(song.title + ' ' + allLineTexts.join(' '));
  const words = haystack.split(' ');
  const hit = BANNED_WORDS.find(w => words.includes(w));
  if (hit) throw new Error('Submission contains disallowed language.');
}

function checkDuplicate(song, allLineTexts, existing) {
  const normTitle = normalizeForMatch(song.title);
  const normLyrics = normalizeForMatch(allLineTexts.join(' '));
  const dup = existing.find(s => {
    if (s.videoId && s.videoId === song.videoId) return true;
    const sLyrics = normalizeForMatch((s.verses || []).flatMap(v => (v.lines || []).map(l => l.text)).join(' '));
    return normalizeForMatch(s.title) === normTitle && sLyrics === normLyrics;
  });
  if (dup) throw new Error(`This song (or its video) is already in the library: "${dup.title}".`);
}

function buildCleanEntry(song) {
  return {
    title: song.title.trim(),
    videoId: song.videoId,
    bcp47: typeof song.bcp47 === 'string' ? song.bcp47 : 'fi-FI',
    rtl: false,
    nonLatin: false,
    contributedAt: new Date().toISOString(),
    verses: song.verses.map(vs => ({
      lines: vs.lines.map(l => ({
        text: l.text,
        start: l.start,
        end: l.end,
        verbs: (l.verbs || []).map(vb => ({
          surface: vb.surface,
          infinitive: vb.infinitive,
          options: vb.options.map(o => ({ form: o.form }))
        }))
      }))
    }))
  };
}

module.exports = async ({ github, context, core }) => {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const issue = context.payload.issue;

  async function reject(reason) {
    await github.rest.issues.createComment({
      owner, repo, issue_number: issue.number,
      body: `❌ Submission rejected: ${reason}`
    });
    await github.rest.issues.update({
      owner, repo, issue_number: issue.number,
      state: 'closed', labels: ['song-submission', 'rejected']
    });
  }

  try {
    const body = issue.body || '';
    const rawSize = Buffer.byteLength(body, 'utf8');
    if (rawSize > MAX_JSON_BYTES) {
      await reject('Submission payload is unexpectedly large — likely corrupted.');
      return;
    }

    const song = extractJsonBlock(body);
    if (!song) {
      await reject('Could not find a valid JSON code block in the issue body.');
      return;
    }

    const allLineTexts = validateStructure(song);
    checkProfanity(song, allLineTexts);

    // Fetch current library
    let existing = [];
    let sha;
    try {
      const res = await github.rest.repos.getContent({ owner, repo, path: DATA_PATH, ref: BASE_BRANCH });
      sha = res.data.sha;
      existing = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
      if (!Array.isArray(existing)) existing = [];
    } catch (e) {
      existing = [];
    }

    checkDuplicate(song, allLineTexts, existing);

    const clean = buildCleanEntry(song);
    existing.push(clean);
    const newContent = Buffer.from(JSON.stringify(existing, null, 2) + '\n', 'utf8').toString('base64');

    const branch = `song-submission-${issue.number}`;
    const mainRef = await github.rest.git.getRef({ owner, repo, ref: `heads/${BASE_BRANCH}` });
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: mainRef.data.object.sha });
    await github.rest.repos.createOrUpdateFileContents({
      owner, repo, path: DATA_PATH,
      message: `Add song: ${clean.title} (#${issue.number})`,
      content: newContent, sha, branch
    });

    const pr = await github.rest.pulls.create({
      owner, repo,
      title: `Add song: ${clean.title}`,
      head: branch, base: BASE_BRANCH,
      body: `Auto-submitted via #${issue.number}. Passed validation: word count, structure, profanity filter, duplicate check.`
    });

    let merged = false;
    try {
      await github.rest.pulls.merge({ owner, repo, pull_number: pr.data.number, merge_method: 'squash' });
      merged = true;
    } catch (e) {
      // branch protection or other block — leave PR open for manual merge
      merged = false;
    }

    await github.rest.issues.createComment({
      owner, repo, issue_number: issue.number,
      body: merged
        ? `✅ Added to the community library! ${pr.data.html_url}`
        : `✅ Validation passed. Could not auto-merge (branch protection?) — please merge manually: ${pr.data.html_url}`
    });
    await github.rest.issues.update({
      owner, repo, issue_number: issue.number,
      state: 'closed', labels: ['song-submission', 'approved']
    });
  } catch (err) {
    await reject(err.message || String(err));
  }
};
