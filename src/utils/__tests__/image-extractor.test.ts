import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractImagePaths } from '../image-extractor.js';

describe('extractImagePaths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'image-extractor-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when cwd is not provided', () => {
    const content = './screenshot.png';
    const result = extractImagePaths(content);
    expect(result).toEqual([]);
  });

  it('returns empty array when cwd is empty string', () => {
    const content = './screenshot.png';
    const result = extractImagePaths(content, '');
    expect(result).toEqual([]);
  });

  it('rejects paths outside the working directory', () => {
    // Create a file outside the working directory
    const outsideDir = mkdtempSync(join(tmpdir(), 'image-extractor-outside-'));
    const outsideFile = join(outsideDir, 'secret.png');
    writeFileSync(outsideFile, 'fake-image-data');

    try {
      // Try to access the outside file via traversal
      const content = `../../${outsideFile} and also ${outsideFile}`;
      const result = extractImagePaths(content, tempDir);
      // No images from outside the working directory should be returned
      const outsidePaths = result.filter(img =>
        img.resolvedPath.startsWith(outsideDir)
      );
      expect(outsidePaths).toEqual([]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects symlinks pointing outside the working directory', () => {
    // Create a file outside the working directory
    const outsideDir = mkdtempSync(join(tmpdir(), 'image-extractor-outside-'));
    const outsideFile = join(outsideDir, 'secret.png');
    writeFileSync(outsideFile, 'fake-image-data');

    // Create a symlink inside the working directory that points outside
    const symlinkPath = join(tempDir, 'link.png');
    symlinkSync(outsideFile, symlinkPath);

    try {
      const content = `${symlinkPath}`;
      const result = extractImagePaths(content, tempDir);
      expect(result).toEqual([]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects files over the 50MB size limit', () => {
    const largeFile = join(tempDir, 'huge.png');
    // Create a file just over 50MB using a sparse file approach
    const fd = require('fs').openSync(largeFile, 'w');
    // Write 1 byte at position 50MB + 1 to create a sparse file > 50MB
    const buf = Buffer.alloc(1, 0);
    require('fs').writeSync(fd, buf, 0, 1, 50 * 1024 * 1024 + 1);
    require('fs').closeSync(fd);

    const content = `${largeFile}`;
    const result = extractImagePaths(content, tempDir);
    expect(result).toEqual([]);
  });

  it('accepts valid image files within the working directory', () => {
    const imageFile = join(tempDir, 'screenshot.png');
    writeFileSync(imageFile, 'fake-png-data');

    const content = `Here is the image: ${imageFile}`;
    const result = extractImagePaths(content, tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].resolvedPath).toBe(imageFile);
  });

  it('accepts images in subdirectories of the working directory', () => {
    const subDir = join(tempDir, 'images', 'screenshots');
    mkdirSync(subDir, { recursive: true });
    const imageFile = join(subDir, 'capture.jpg');
    writeFileSync(imageFile, 'fake-jpg-data');

    const content = `Check ${imageFile}`;
    const result = extractImagePaths(content, tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].resolvedPath).toBe(imageFile);
  });

  it('accepts relative paths resolved within the working directory', () => {
    const imageFile = join(tempDir, 'photo.png');
    writeFileSync(imageFile, 'fake-png-data');

    const content = './photo.png';
    const result = extractImagePaths(content, tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].resolvedPath).toBe(imageFile);
  });

  it('rejects absolute paths outside the working directory', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'image-extractor-outside-'));
    const outsideFile = join(outsideDir, 'private.png');
    writeFileSync(outsideFile, 'fake-image-data');

    try {
      const content = outsideFile;
      const result = extractImagePaths(content, tempDir);
      expect(result).toEqual([]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('accepts files exactly at 50MB', () => {
    const file = join(tempDir, 'exact50.png');
    // Create a sparse file of exactly 50MB
    const fd = require('fs').openSync(file, 'w');
    const buf = Buffer.alloc(1, 0);
    // Write at position 50*1024*1024 - 1 to make the file exactly 50MB
    require('fs').writeSync(fd, buf, 0, 1, 50 * 1024 * 1024 - 1);
    require('fs').closeSync(fd);

    const content = `${file}`;
    const result = extractImagePaths(content, tempDir);
    expect(result).toHaveLength(1);
  });
});
