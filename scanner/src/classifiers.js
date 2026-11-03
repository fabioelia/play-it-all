// Frame classifiers. Each returns { name, categories, score(rgb, size) → { [category]: 0..1 } }.
//
//  heuristic  no model, no dependencies: skin-tone and blood-red pixel ratios.
//             Crude, so scores are capped at 0.5: below the extension's default
//             0.6 confidence, they only ever appear as suggestions.
//  onnx       any Hugging Face style ONNX image classifier (config.json with
//             id2label + preprocessor_config.json next to onnx/model*.onnx),
//             e.g. onnx-community/nsfw_image_detection-ONNX. Labels map onto
//             CleanCut categories with --map "nsfw=nudity".

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { CATEGORY_IDS } from '../../shared/ratings.js';

export function heuristicClassifier({ cap = 0.5 } = {}) {
  return {
    name: 'heuristic',
    categories: ['nudity', 'gore'],
    async score(rgb) {
      let skin = 0;
      let blood = 0;
      const n = rgb.length / 3;
      for (let i = 0; i < rgb.length; i += 3) {
        const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
        // Skin in YCbCr (Chai & Ngan 1999).
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 && r > 60) skin++;
        if (r > 90 && r > 2.2 * g && r > 2.2 * b) blood++;
      }
      const ramp = (ratio, lo, hi) => Math.max(0, Math.min(1, (ratio - lo) / (hi - lo)));
      return {
        nudity: cap * ramp(skin / n, 0.25, 0.7),
        gore: cap * ramp(blood / n, 0.15, 0.5),
      };
    },
  };
}

/** Parse "nsfw=nudity,gore=gore" into { nsfw: 'nudity', gore: 'gore' }. */
export function parseLabelMap(spec) {
  const map = {};
  for (const pair of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [label, category] = pair.split('=').map((s) => s.trim());
    if (!label || !CATEGORY_IDS.includes(category)) throw new Error(`bad --map entry "${pair}" (category must be one of ${CATEGORY_IDS.join(', ')})`);
    map[label] = category;
  }
  return map;
}

function findModelFiles(path) {
  let model = path;
  let dir = path;
  if (statSync(path).isDirectory()) {
    const onnxDir = existsSync(join(path, 'onnx')) ? join(path, 'onnx') : path;
    const prefer = ['model_quantized.onnx', 'model_int8.onnx', 'model_uint8.onnx', 'model.onnx'];
    const files = readdirSync(onnxDir).filter((f) => f.endsWith('.onnx'));
    const pick = prefer.find((f) => files.includes(f)) || files[0];
    if (!pick) throw new Error(`no .onnx file in ${onnxDir}`);
    model = join(onnxDir, pick);
  } else {
    dir = dirname(path);
  }
  const lookup = (name) => [dir, dirname(dir), dirname(model)].map((d) => join(d, name)).find(existsSync);
  return { model, config: lookup('config.json'), preprocessor: lookup('preprocessor_config.json') };
}

export async function onnxClassifier({ model: modelPath, map, labels: labelOverride }) {
  const require = createRequire(import.meta.url);
  let ort;
  try {
    ort = require('onnxruntime-node');
  } catch {
    throw new Error('onnxruntime-node is not installed. Run: npm install onnxruntime-node');
  }
  const files = findModelFiles(modelPath);
  const config = files.config ? JSON.parse(readFileSync(files.config, 'utf8')) : {};
  const pre = files.preprocessor ? JSON.parse(readFileSync(files.preprocessor, 'utf8')) : {};
  const id2label = labelOverride || config.id2label;
  if (!id2label) throw new Error('model has no id2label (config.json); pass --labels "0=normal,1=nsfw"');
  const size = pre.size?.height || pre.size?.shortest_edge || config.image_size || 224;
  const mean = pre.image_mean || [0.485, 0.456, 0.406];
  const std = pre.image_std || [0.229, 0.224, 0.225];
  const rescale = pre.rescale_factor ?? 1 / 255;
  const labelMap = Object.keys(map).length ? map : {};
  const unknown = Object.keys(labelMap).filter((l) => !Object.values(id2label).includes(l));
  if (unknown.length) throw new Error(`--map label(s) ${unknown.join(', ')} not in model labels: ${Object.values(id2label).join(', ')}`);

  const session = await ort.InferenceSession.create(files.model, { graphOptimizationLevel: 'all' });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  return {
    name: `onnx:${files.model}`,
    size,
    categories: [...new Set(Object.values(labelMap))],
    labels: id2label,
    async score(rgb, frameSize) {
      if (frameSize !== size) throw new Error(`frames must be ${size}px for this model (got ${frameSize})`);
      const plane = size * size;
      const data = new Float32Array(3 * plane);
      for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) data[c * plane + i] = (rgb[i * 3 + c] * rescale - mean[c]) / std[c];
      }
      const out = await session.run({ [inputName]: new ort.Tensor('float32', data, [1, 3, size, size]) });
      const logits = Array.from(out[outputName].data);
      const max = Math.max(...logits);
      const exps = logits.map((l) => Math.exp(l - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      const scores = {};
      exps.forEach((e, i) => {
        const category = labelMap[id2label[i]];
        if (category) scores[category] = Math.max(scores[category] || 0, e / sum);
      });
      return scores;
    },
  };
}
