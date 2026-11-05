// Speech models CleanCut can listen with. Each is downloaded once, on the
// viewer's opt-in, from Hugging Face at a pinned commit, checked against the
// sizes and digests below, and kept in the extension's own Cache Storage.
// Inference runs on this computer; audio never leaves it.
//
// Only DEFAULT_MODEL ships in the UI. The others are here so the benchmark
// (test/perf/listen-model.mjs) can compare them on the same footing; the
// numbers behind the choice are in README.md ("Listening ahead").
//
// Fields:
//   repo, revision   Hugging Face repository and the commit its files are read at
//   kind             'whisper' (word timestamps from cross-attention) or 'moonshine' (text only)
//   words            true when the model gives word-level timestamps
//   dtype            per-file quantization, as transformers.js names it
//   files            [path, bytes, digest]: 'sha256:<hex>' for the large (LFS)
//                    files, 'git:<sha1>' (the git blob id) for the small JSON ones

export const MODEL_HOST = 'https://huggingface.co/';

export const MODELS = {
  'whisper-tiny.en': {
    name: 'Whisper tiny.en (int8)',
    repo: 'onnx-community/whisper-tiny.en_timestamped',
    revision: 'aeaa13760958b03fac5062f457d317d3319c3168',
    license: 'MIT (OpenAI Whisper)',
    kind: 'whisper',
    words: true,
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    files: [
      ['config.json', 2197, 'git:909d31b7c4123f177a3cb4c536a115d8ed758d4e'],
      ['generation_config.json', 1646, 'git:c4a4cdec79d2ecbce5b0c7d0cdefd8fec293da1f'],
      ['preprocessor_config.json', 339, 'git:91876762a536a746d268353c5cba57286e76b058'],
      ['tokenizer.json', 2405679, 'git:b5bd266de2f9b9a68efe13fb48ac6830ca71c0bb'],
      ['tokenizer_config.json', 282662, 'git:220314442bbc85c24bb2ee0b4b8d682615dd79e7'],
      ['onnx/encoder_model_quantized.onnx', 10097112, 'sha256:697eaa5668bb13343965f423d6002273479b8508f592bd26970735516ed5039e'],
      ['onnx/decoder_model_merged_quantized.onnx', 30729881, 'sha256:f2df67fbe1cf39c9b050d05029b55e217a9467f3453ae5110e2bcc0f5ba73652'],
    ],
  },
  'whisper-base.en': {
    name: 'Whisper base.en (int8)',
    repo: 'onnx-community/whisper-base.en_timestamped',
    revision: 'fa239a41836c3305f6beec180e5940f3823ff5b8',
    license: 'MIT (OpenAI Whisper)',
    kind: 'whisper',
    words: true,
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    files: [
      ['config.json', 2197, 'git:1d26eef96852a247a15abeee24630b81de8c5835'],
      ['generation_config.json', 1556, 'git:84c050f8e56d93c2b29d9768be849360960483a7'],
      ['preprocessor_config.json', 339, 'git:91876762a536a746d268353c5cba57286e76b058'],
      ['tokenizer.json', 2405679, 'git:b5bd266de2f9b9a68efe13fb48ac6830ca71c0bb'],
      ['tokenizer_config.json', 282662, 'git:220314442bbc85c24bb2ee0b4b8d682615dd79e7'],
      ['onnx/encoder_model_quantized.onnx', 23159173, 'sha256:9b4d25507aef3d3a8d718695b8adcb0488e66aad8e884333c3fa73a1c3baa906'],
      ['onnx/decoder_model_merged_quantized.onnx', 53712196, 'sha256:afa8065a5f023f6e524417f9459cc09969023dd38149cd4dce16628b2c3a1773'],
    ],
  },
  'moonshine-tiny': {
    name: 'Moonshine tiny (int8)',
    repo: 'onnx-community/moonshine-tiny-ONNX',
    revision: 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95',
    license: 'MIT (Useful Sensors)',
    kind: 'moonshine',
    words: false,
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    files: [
      ['config.json', 921, 'git:3b8918edc926194c698c6d3255adac22b50251f6'],
      ['generation_config.json', 147, 'git:b45f5d83177964a069f943e80225213bd724200f'],
      ['preprocessor_config.json', 128, 'git:e519add8190c4ef53802d1d593b7973c12ae68c9'],
      ['tokenizer.json', 3761754, 'git:3e2e6918436f479b267467608eccc4ade30c251c'],
      ['tokenizer_config.json', 135735, 'git:a712a75cf20ba1c6e6f1761f2b612c7ecc44ffa0'],
      ['onnx/encoder_model_quantized.onnx', 7937661, 'sha256:c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a'],
      ['onnx/decoder_model_merged_quantized.onnx', 20243286, 'sha256:eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367'],
    ],
  },
  'moonshine-base': {
    name: 'Moonshine base (int8)',
    repo: 'onnx-community/moonshine-base-ONNX',
    revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
    license: 'MIT (Useful Sensors)',
    kind: 'moonshine',
    words: false,
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    files: [
      ['config.json', 922, 'git:1967bf9b1c79c1fa70166a300e3882136593e921'],
      ['generation_config.json', 147, 'git:b45f5d83177964a069f943e80225213bd724200f'],
      ['preprocessor_config.json', 128, 'git:e519add8190c4ef53802d1d593b7973c12ae68c9'],
      ['tokenizer.json', 3761754, 'git:3e2e6918436f479b267467608eccc4ade30c251c'],
      ['tokenizer_config.json', 135735, 'git:a712a75cf20ba1c6e6f1761f2b612c7ecc44ffa0'],
      ['onnx/encoder_model_quantized.onnx', 20513063, 'sha256:1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751'],
      ['onnx/decoder_model_merged_quantized.onnx', 42498870, 'sha256:cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3'],
    ],
  },
};

export const DEFAULT_MODEL = 'whisper-tiny.en';

/** Total download size in bytes. */
export const modelBytes = (m) => m.files.reduce((n, [, bytes]) => n + bytes, 0);

/** "44 MB" */
export const modelSizeLabel = (m) => `${Math.round(modelBytes(m) / 1e6)} MB`;

/** Where a file lives on the model host. Files are cached under the Hugging Face address, whatever host served them. */
export const fileUrl = (m, path, host = MODEL_HOST) => `${host.replace(/\/?$/, '/')}${m.repo}/resolve/${m.revision}/${path}`;

/** The page that describes the model, for the consent text and Options. */
export const modelPage = (m) => `https://huggingface.co/${m.repo}/tree/${m.revision}`;

/** Cache Storage bucket the files are kept in (the extension's own origin, never a site's). */
export const MODEL_CACHE = 'cleancut-models-v1';

/** Check a downloaded file against its pinned digest. Works in workers, pages and Node 22. */
export async function verifyDigest(bytes, digest) {
  const [kind, want] = String(digest).split(':');
  let data = bytes;
  let algo = 'SHA-256';
  if (kind === 'git') {
    // A git blob id is SHA-1 over "blob <size>\0" + content.
    const head = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    data = new Uint8Array(head.length + bytes.byteLength);
    data.set(head, 0);
    data.set(bytes, head.length);
    algo = 'SHA-1';
  } else if (kind !== 'sha256') return false;
  const hash = new Uint8Array(await crypto.subtle.digest(algo, data));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('') === want;
}
