/**
 * Self-Contained Offline SVG QR Code Generator (Zero-Dependency)
 * Model 2 QR Code Generator (Byte mode, Auto Version 1-40, Reed-Solomon ECC, Masking)
 */
class SVGQRCode {
    static generateSVG(text, size = 180) {
        const qr = SVGQRCode.encodeText(text, SVGQRCode.Ecc.LOW);
        return qr.toSVGString(size);
    }

    static renderInto(containerEl, text, size = 180) {
        if (!containerEl) return;
        containerEl.innerHTML = SVGQRCode.generateSVG(text, size);
    }

    /**
     * Encodes text into a QR Code matrix.
     */
    static encodeText(text, ecc) {
        const encoder = new TextEncoder();
        const dataBytes = encoder.encode(text);
        
        if (dataBytes.length > 2953) {
            throw new Error(`QR data too large: ${dataBytes.length} bytes (max ~2953)`);
        }

        // Find smallest version (1 to 40) that fits dataBytes with ECC level
        let version = 1;
        for (; version <= 40; version++) {
            const capacity = SVGQRCode.getNumDataCodewords(version, ecc);
            const headerBitLen = 4 + SVGQRCode.getCharCountIndicatorBitLength(version);
            const totalBits = headerBitLen + dataBytes.length * 8;
            if (totalBits <= capacity * 8) {
                break;
            }
        }

        if (version > 40) {
            throw new Error(`QR data too large: ${dataBytes.length} bytes (max ~2953)`);
        }

        return new SVGQRCode.QrCode(version, ecc, dataBytes);
    }
}

// QR Code Constants & Tables
SVGQRCode.Ecc = {
    LOW: { ordinal: 0, formatBits: 1 },
    MEDIUM: { ordinal: 1, formatBits: 0 },
    QUARTILE: { ordinal: 2, formatBits: 3 },
    HIGH: { ordinal: 3, formatBits: 2 }
};

SVGQRCode.getCharCountIndicatorBitLength = function(version) {
    if (version <= 9) return 8;
    if (version <= 26) return 16;
    return 16;
};

// ECC Codewords Table per version and ECC level: [totalCodewords, eccCodewordsPerBlock, numBlocks]
// Reference QR Code spec Table 9
SVGQRCode.ECC_TABLE = [
    // Ver 1-10
    null,
    [[26, 7, 1], [26, 10, 1], [26, 13, 1], [26, 17, 1]], // 1
    [[44, 10, 1], [44, 16, 1], [44, 22, 1], [44, 28, 1]], // 2
    [[70, 15, 1], [70, 26, 1], [70, 18, 2], [70, 22, 2]], // 3
    [[100, 20, 1], [100, 18, 2], [100, 26, 2], [100, 16, 4]], // 4
    [[134, 26, 1], [134, 24, 2], [134, 18, 2, 22, 2], [134, 22, 2, 26, 2]], // 5
    [[172, 18, 2], [172, 16, 4], [172, 24, 4], [172, 28, 4]], // 6
    [[196, 20, 2], [196, 18, 4], [196, 18, 2, 24, 4], [196, 26, 4, 18, 1]], // 7
    [[242, 24, 2], [242, 22, 2, 26, 2], [242, 22, 4, 26, 2], [242, 26, 4, 22, 2]], // 8
    [[292, 30, 2], [292, 22, 3, 24, 2], [292, 20, 4, 24, 4], [292, 24, 4, 28, 4]], // 9
    [[346, 18, 2, 20, 2], [346, 26, 4, 28, 1], [346, 24, 6, 28, 2], [346, 28, 6, 26, 2]], // 10
    // Ver 11-20
    [[404, 20, 4], [404, 30, 1, 26, 4], [404, 28, 4, 24, 4], [404, 24, 3, 22, 8]], // 11
    [[466, 24, 2, 22, 2], [466, 22, 6, 26, 2], [466, 26, 4, 28, 6], [466, 28, 7, 24, 4]], // 12
    [[532, 26, 4], [532, 22, 8, 24, 1], [532, 24, 8, 20, 4], [532, 22, 12, 26, 4]], // 13
    [[581, 30, 3, 30, 1], [581, 24, 4, 22, 5], [581, 20, 11, 24, 5], [581, 24, 11, 30, 5]], // 14
    [[655, 22, 5, 24, 1], [655, 24, 5, 30, 5], [655, 30, 5, 28, 7], [655, 24, 11, 30, 7]], // 15
    [[733, 24, 5, 20, 1], [733, 28, 7, 26, 3], [733, 24, 15, 20, 2], [733, 30, 3, 24, 13]], // 16
    [[815, 28, 1, 28, 5], [815, 28, 10, 26, 1], [815, 28, 1, 28, 15], [815, 28, 2, 28, 17]], // 17
    [[901, 30, 5, 26, 5], [901, 26, 9, 28, 4], [901, 28, 17, 28, 1], [901, 28, 2, 28, 19]], // 18
    [[991, 28, 3, 26, 8], [991, 26, 3, 26, 11], [991, 26, 17, 24, 4], [991, 28, 9, 26, 16]], // 19
    [[1085, 28, 3, 26, 10], [1085, 26, 3, 26, 13], [1085, 30, 15, 28, 5], [1085, 28, 15, 24, 10]], // 20
    // Ver 21-30
    [[1156, 28, 4, 26, 9], [1156, 26, 17], [1156, 28, 17, 24, 6], [1156, 30, 19, 28, 6]], // 21
    [[1258, 28, 2, 28, 11], [1258, 28, 17], [1258, 30, 7, 28, 16], [1258, 24, 34]], // 22
    [[1364, 30, 4, 28, 11], [1364, 28, 4, 28, 14], [1364, 30, 11, 24, 14], [1364, 30, 16, 30, 14]], // 23
    [[1474, 30, 6, 28, 11], [1474, 28, 6, 28, 14], [1474, 30, 11, 28, 16], [1474, 30, 30, 30, 2]], // 24
    [[1588, 26, 8, 28, 11], [1588, 28, 8, 26, 13], [1588, 30, 7, 26, 22], [1588, 30, 22, 28, 13]], // 25
    [[1706, 28, 10, 28, 11], [1706, 28, 19, 26, 4], [1706, 28, 28, 24, 6], [1706, 30, 33, 24, 4]], // 26
    [[1828, 28, 8, 28, 13], [1828, 28, 22, 26, 3], [1828, 30, 8, 26, 26], [1828, 30, 12, 28, 28]], // 27
    [[1921, 28, 3, 28, 17], [1921, 28, 3, 26, 23], [1921, 30, 4, 26, 31], [1921, 30, 11, 30, 31]], // 28
    [[2051, 28, 7, 28, 19], [2051, 28, 21, 26, 7], [2051, 30, 1, 28, 37], [2051, 30, 19, 26, 26]], // 29
    [[2185, 28, 5, 28, 21], [2185, 28, 19, 26, 10], [2185, 30, 15, 28, 25], [2185, 30, 23, 28, 25]], // 30
    // Ver 31-40
    [[2323, 28, 13, 28, 17], [2323, 28, 2, 28, 29], [2323, 30, 42, 28, 1], [2323, 30, 23, 28, 28]], // 31
    [[2465, 28, 17, 28, 16], [2465, 28, 10, 26, 23], [2465, 30, 10, 28, 35], [2465, 30, 19, 28, 35]], // 32
    [[2611, 28, 17, 28, 19], [2611, 28, 14, 26, 21], [2611, 30, 29, 28, 19], [2611, 30, 11, 30, 46]], // 33
    [[2761, 28, 13, 28, 25], [2761, 28, 14, 26, 23], [2761, 30, 44, 28, 7], [2761, 30, 59, 30, 1]], // 34
    [[2876, 28, 12, 28, 25], [2876, 28, 12, 26, 27], [2876, 30, 39, 28, 14], [2876, 30, 22, 30, 41]], // 35
    [[3034, 28, 6, 28, 33], [3034, 28, 6, 26, 40], [3034, 30, 46, 28, 10], [3034, 30, 2, 30, 64]], // 36
    [[3196, 28, 17, 28, 25], [3196, 28, 29, 26, 19], [3196, 30, 49, 28, 10], [3196, 30, 24, 30, 46]], // 37
    [[3362, 28, 4, 28, 40], [3362, 28, 19, 26, 35], [3362, 30, 48, 28, 14], [3362, 30, 42, 30, 32]], // 38
    [[3532, 28, 20, 28, 25], [3532, 28, 35, 26, 23], [3532, 30, 43, 28, 22], [3532, 30, 10, 30, 67]], // 39
    [[3706, 28, 19, 28, 35], [3706, 28, 3, 26, 58], [3706, 30, 34, 28, 34], [3706, 30, 20, 30, 61]]  // 40
];

SVGQRCode.getNumDataCodewords = function(version, ecc) {
    const entry = SVGQRCode.ECC_TABLE[version][ecc.ordinal];
    const totalCodewords = entry[0];
    let ecCodewords = 0;
    if (entry.length === 3) {
        ecCodewords = entry[1] * entry[2];
    } else if (entry.length === 5) {
        ecCodewords = entry[1] * entry[2] + entry[3] * entry[4];
    }
    return totalCodewords - ecCodewords;
};

// Alignment pattern centers per version
SVGQRCode.ALIGNMENT_PATTERNS = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58],
    [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
];

// Reed-Solomon GF(256) Math
SVGQRCode.ReedSolomon = class {
    static multiply(x, y) {
        return (x !== 0 && y !== 0) ? SVGQRCode.ReedSolomon.EXP_TABLE[(SVGQRCode.ReedSolomon.LOG_TABLE[x] + SVGQRCode.ReedSolomon.LOG_TABLE[y]) % 255] : 0;
    }

    static computeDivisor(degree) {
        let result = new Uint8Array(degree);
        result[degree - 1] = 1;
        let root = 1;
        for (let i = 0; i < degree; i++) {
            for (let j = 0; j < degree; j++) {
                result[j] = SVGQRCode.ReedSolomon.multiply(result[j], root);
                if (j + 1 < degree) {
                    result[j] ^= result[j + 1];
                }
            }
            root = SVGQRCode.ReedSolomon.multiply(root, 0x02);
        }
        return result;
    }

    static computeRemainder(data, degree) {
        const divisor = SVGQRCode.ReedSolomon.computeDivisor(degree);
        const result = new Uint8Array(degree);
        for (const byte of data) {
            const factor = byte ^ result[0];
            result.copyWithin(0, 1);
            result[degree - 1] = 0;
            for (let i = 0; i < degree; i++) {
                result[i] ^= SVGQRCode.ReedSolomon.multiply(divisor[i], factor);
            }
        }
        return result;
    }
};

// Initialize GF(256) tables with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
SVGQRCode.ReedSolomon.EXP_TABLE = new Uint8Array(256);
SVGQRCode.ReedSolomon.LOG_TABLE = new Uint8Array(256);
(function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        SVGQRCode.ReedSolomon.EXP_TABLE[i] = x;
        SVGQRCode.ReedSolomon.LOG_TABLE[x] = i;
        x <<= 1;
        if (x & 0x100) {
            x ^= 0x11D;
        }
    }
    SVGQRCode.ReedSolomon.EXP_TABLE[255] = SVGQRCode.ReedSolomon.EXP_TABLE[0];
})();

// Core QrCode Matrix Generator
SVGQRCode.QrCode = class {
    constructor(version, ecc, dataBytes) {
        this.version = version;
        this.ecc = ecc;
        this.size = version * 4 + 17;

        this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
        this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));

        this.drawFunctionPatterns();

        const dataBits = this.encodeDataBits(dataBytes);
        const codewords = this.generateCodewords(dataBits);
        
        let bestMask = 0;
        let minPenalty = Infinity;

        for (let mask = 0; mask < 8; mask++) {
            this.drawCodewords(codewords);
            this.applyMask(mask);
            this.drawFormatBits(mask);
            const penalty = this.getPenaltyScore();
            if (penalty < minPenalty) {
                minPenalty = penalty;
                bestMask = mask;
            }
            this.applyMask(mask); // Unmask for next iteration
        }

        this.drawCodewords(codewords);
        this.applyMask(bestMask);
        this.drawFormatBits(bestMask);
    }

    setFunctionModule(x, y, isDark) {
        this.modules[y][x] = isDark;
        this.isFunction[y][x] = true;
    }

    drawFunctionPatterns() {
        // Finder patterns (top-left, top-right, bottom-left)
        this.drawFinderPattern(0, 0);
        this.drawFinderPattern(this.size - 7, 0);
        this.drawFinderPattern(0, this.size - 7);

        // Alignment patterns
        const alignCoords = SVGQRCode.ALIGNMENT_PATTERNS[this.version];
        for (let i = 0; i < alignCoords.length; i++) {
            for (let j = 0; j < alignCoords.length; j++) {
                const x = alignCoords[i];
                const y = alignCoords[j];
                // Don't overlap with finder patterns
                if ((i === 0 && j === 0) || (i === 0 && j === alignCoords.length - 1) || (i === alignCoords.length - 1 && j === 0)) {
                    continue;
                }
                this.drawAlignmentPattern(x, y);
            }
        }

        // Timing lines
        for (let i = 0; i < this.size; i++) {
            this.setFunctionModule(6, i, i % 2 === 0);
            this.setFunctionModule(i, 6, i % 2 === 0);
        }

        // Dummy format & version modules
        this.drawFormatBits(0);
        this.drawVersionBits();
    }

    drawFinderPattern(x, y) {
        for (let dy = -1; dy <= 7; dy++) {
            for (let dx = -1; dx <= 7; dx++) {
                const px = x + dx;
                const py = y + dy;
                if (px >= 0 && px < this.size && py >= 0 && py < this.size) {
                    const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
                    const isDark = dist !== 2 && dist !== 4;
                    this.setFunctionModule(px, py, isDark);
                }
            }
        }
    }

    drawAlignmentPattern(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const isDark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
                this.setFunctionModule(cx + dx, cy + dy, isDark);
            }
        }
    }

    drawFormatBits(mask) {
        const data = (this.ecc.formatBits << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;

        // Draw format bits around finders
        for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, ((bits >> i) & 1) !== 0);
        this.setFunctionModule(8, 7, ((bits >> 6) & 1) !== 0);
        this.setFunctionModule(8, 8, ((bits >> 7) & 1) !== 0);
        this.setFunctionModule(7, 8, ((bits >> 8) & 1) !== 0);
        for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, ((bits >> i) & 1) !== 0);

        for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, ((bits >> i) & 1) !== 0);
        for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, ((bits >> i) & 1) !== 0);
        this.setFunctionModule(8, this.size - 8, true); // Dark module
    }

    drawVersionBits() {
        if (this.version < 7) return;
        let rem = this.version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
        const bits = (this.version << 12) | rem;

        for (let i = 0; i < 18; i++) {
            const isDark = ((bits >> i) & 1) !== 0;
            const a = this.size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this.setFunctionModule(a, b, isDark);
            this.setFunctionModule(b, a, isDark);
        }
    }

    encodeDataBits(dataBytes) {
        const bits = [];
        const appendBits = (val, len) => {
            for (let i = len - 1; i >= 0; i--) {
                bits.push((val >> i) & 1);
            }
        };

        // Byte mode indicator = 0100 (4)
        appendBits(0b0100, 4);
        // Character count indicator
        const countBits = SVGQRCode.getCharCountIndicatorBitLength(this.version);
        appendBits(dataBytes.length, countBits);
        // Data bytes
        for (const byte of dataBytes) {
            appendBits(byte, 8);
        }

        const dataCapacityBits = SVGQRCode.getNumDataCodewords(this.version, this.ecc) * 8;
        // Terminator
        const termLen = Math.min(4, dataCapacityBits - bits.length);
        appendBits(0, termLen);

        // Byte alignment
        while (bits.length % 8 !== 0) {
            bits.push(0);
        }

        // Pad bytes (0xEC, 0x11)
        const padBytes = [0xEC, 0x11];
        let padIdx = 0;
        while (bits.length < dataCapacityBits) {
            appendBits(padBytes[padIdx], 8);
            padIdx = (padIdx + 1) % 2;
        }

        // Convert to Uint8Array of codewords
        const codewords = new Uint8Array(bits.length / 8);
        for (let i = 0; i < codewords.length; i++) {
            let byte = 0;
            for (let b = 0; b < 8; b++) {
                byte = (byte << 1) | bits[i * 8 + b];
            }
            codewords[i] = byte;
        }
        return codewords;
    }

    generateCodewords(dataCodewords) {
        const entry = SVGQRCode.ECC_TABLE[this.version][this.ecc.ordinal];
        const numBlocks = entry.length === 3 ? entry[2] : entry[2] + entry[4];
        const ecCodewordsPerBlock = entry[1];
        
        const blocks = [];
        const ecBlocks = [];

        let dataOffset = 0;
        const numShortBlocks = entry.length === 5 ? entry[2] : numBlocks;
        const shortBlockLen = Math.floor(dataCodewords.length / numBlocks);

        for (let i = 0; i < numBlocks; i++) {
            const len = (i < numShortBlocks) ? shortBlockLen : shortBlockLen + 1;
            const blockData = dataCodewords.subarray(dataOffset, dataOffset + len);
            dataOffset += len;
            blocks.push(blockData);
            ecBlocks.push(SVGQRCode.ReedSolomon.computeRemainder(blockData, ecCodewordsPerBlock));
        }

        // Interleave data codewords
        const result = [];
        const maxBlockLen = Math.max(...blocks.map(b => b.length));
        for (let i = 0; i < maxBlockLen; i++) {
            for (let b = 0; b < numBlocks; b++) {
                if (i < blocks[b].length) {
                    result.push(blocks[b][i]);
                }
            }
        }
        // Interleave EC codewords
        for (let i = 0; i < ecCodewordsPerBlock; i++) {
            for (let b = 0; b < numBlocks; b++) {
                result.push(ecBlocks[b][i]);
            }
        }

        return new Uint8Array(result);
    }

    drawCodewords(codewords) {
        let bitIdx = 0;
        const totalBits = codewords.length * 8;

        for (let right = this.size - 1; right > 0; right -= 2) {
            if (right === 6) right = 5; // Skip vertical timing line
            for (let vert = 0; vert < this.size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? this.size - 1 - vert : vert;

                    if (!this.isFunction[y][x] && bitIdx < totalBits) {
                        const codewordIdx = Math.floor(bitIdx / 8);
                        const bitPos = 7 - (bitIdx % 8);
                        const isDark = ((codewords[codewordIdx] >> bitPos) & 1) !== 0;
                        this.modules[y][x] = isDark;
                        bitIdx++;
                    }
                }
            }
        }
    }

    applyMask(mask) {
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                if (this.isFunction[y][x]) continue;
                let invert = false;
                switch (mask) {
                    case 0: invert = (x + y) % 2 === 0; break;
                    case 1: invert = y % 2 === 0; break;
                    case 2: invert = x % 3 === 0; break;
                    case 3: invert = (x + y) % 3 === 0; break;
                    case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                    case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                    case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                }
                if (invert) {
                    this.modules[y][x] = !this.modules[y][x];
                }
            }
        }
    }

    getPenaltyScore() {
        let penalty = 0;

        // Rule 1: 5+ consecutive same color in row/col
        for (let y = 0; y < this.size; y++) {
            let runColor = false, runLen = 0;
            for (let x = 0; x < this.size; x++) {
                if (x === 0 || this.modules[y][x] !== runColor) {
                    runColor = this.modules[y][x];
                    runLen = 1;
                } else {
                    runLen++;
                    if (runLen === 5) penalty += 3;
                    else if (runLen > 5) penalty += 1;
                }
            }
        }
        for (let x = 0; x < this.size; x++) {
            let runColor = false, runLen = 0;
            for (let y = 0; y < this.size; y++) {
                if (y === 0 || this.modules[y][x] !== runColor) {
                    runColor = this.modules[y][x];
                    runLen = 1;
                } else {
                    runLen++;
                    if (runLen === 5) penalty += 3;
                    else if (runLen > 5) penalty += 1;
                }
            }
        }

        // Rule 2: 2x2 blocks of same color
        for (let y = 0; y < this.size - 1; y++) {
            for (let x = 0; x < this.size - 1; x++) {
                const color = this.modules[y][x];
                if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) {
                    penalty += 3;
                }
            }
        }

        return penalty;
    }

    toSVGString(pixelSize = 180) {
        const quietZone = 4;
        const totalSize = this.size + quietZone * 2;
        let pathD = '';

        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                if (this.modules[y][x]) {
                    const mx = x + quietZone;
                    const my = y + quietZone;
                    pathD += `M${mx},${my}h1v1h-1z `;
                }
            }
        }

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges"><rect width="${totalSize}" height="${totalSize}" fill="#ffffff"/><path d="${pathD.trim()}" fill="#000000"/></svg>`;
    }
};
