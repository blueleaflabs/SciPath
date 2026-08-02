import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * The checklist prompts and the common mistakes live in the repository as
 * YAML rather than in the database. They are content, edited through pull
 * request and reviewed like content, and the best additions come from
 * mentors right after judging while they still remember what went wrong.
 */

export interface Stage {
  id: string;
  label: string;
}

export interface Prompt {
  id: string;
  stage: string;
  track: 'all' | 'experimental' | 'engineering';
  rubric?: string;
  prompt: string;
}

export interface MistakeGroup {
  stage: string;
  items: string[];
}

interface Bank {
  stages: Stage[];
  prompts: Prompt[];
  mistakes: MistakeGroup[];
}

const file = path.join(process.cwd(), 'src/data/question-bank.yaml');

let cached: Bank | null = null;

export function questionBank(): Bank {
  if (!cached) {
    cached = yaml.load(fs.readFileSync(file, 'utf8')) as Bank;
  }
  return cached;
}

export function stageLabel(id: string): string {
  return questionBank().stages.find((s) => s.id === id)?.label ?? id;
}
