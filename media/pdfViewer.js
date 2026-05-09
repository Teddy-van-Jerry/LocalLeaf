/**
 * LocalLeaf PDF Viewer Script
 * Uses pdf.js to render PDF pages in a VS Code webview.
 * Features: text selection, Ctrl+wheel zoom, Ctrl+click SyncTeX inverse search.
 */

/* global pdfjsLib */

let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let zoomLevel = 1.0;
let rendering = false;
let pendingRender = false;
let pendingRenderAnchor = null;
let renderGeneration = 0;
let zoomDebounceTimer = null;
let renderedZoom = 1.0;

const viewer = document.getElementById('viewer');
const viewerContainer = document.getElementById('viewer-container');
const pageNum = document.getElementById('page-num');
const pageCount = document.getElementById('page-count');
const zoomDisplay = document.getElementById('zoom-level');

const vscode = acquireVsCodeApi();

// ─── Initialisation ──────────────────────────────────────────────

function initViewer(url) {
    loadPdf(url);
}

async function loadPdf(url) {
    try {
        var anchor = capturePdfViewAnchor();

        // Fetch raw bytes with cache: 'no-store' to bypass browser / webview
        // resource-server caching, then hand the ArrayBuffer to pdf.js.
        var resp = await fetch(url, { cache: 'no-store' });
        var data = await resp.arrayBuffer();

        await openPdfData(data, anchor);
    } catch (error) {
        viewer.innerHTML = '<div class="error-message">Failed to load PDF: ' + error.message + '</div>';
    }
}

async function loadPdfFromBase64(base64) {
    try {
        var anchor = capturePdfViewAnchor();

        var raw = atob(base64);
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) {
            bytes[i] = raw.charCodeAt(i);
        }

        await openPdfData(bytes.buffer, anchor);
    } catch (error) {
        viewer.innerHTML = '<div class="error-message">Failed to load PDF: ' + error.message + '</div>';
    }
}

async function openPdfData(data, restoreAnchor) {
    renderGeneration++;

    // Destroy previous document to free memory
    if (pdfDoc) {
        try { pdfDoc.destroy(); } catch (_) {}
    }

    pdfDoc = await pdfjsLib.getDocument({ data: data }).promise;
    totalPages = pdfDoc.numPages;
    pageCount.textContent = totalPages;

    await renderAllPages(restoreAnchor);
}

// ─── Rendering (canvas + text layer) ─────────────────────────────

async function renderAllPages(restoreAnchor) {
    if (rendering) {
        pendingRender = true;
        pendingRenderAnchor = restoreAnchor || pendingRenderAnchor;
        return;
    }

    rendering = true;
    var generation = renderGeneration;
    var doc = pdfDoc;
    viewer.innerHTML = '';

    try {
        for (var i = 1; i <= totalPages; i++) {
            if (generation !== renderGeneration || doc !== pdfDoc) return;
            var page = await doc.getPage(i);
            if (generation !== renderGeneration || doc !== pdfDoc) return;
            var baseViewport = page.getViewport({ scale: 1.0 });
            var viewport = page.getViewport({ scale: zoomLevel });

            // Wrapper (relative position so text layer overlaps canvas)
            var pageDiv = document.createElement('div');
            pageDiv.className = 'pdf-page';
            pageDiv.dataset.pageNum = i;
            pageDiv.dataset.baseWidth = baseViewport.width;
            pageDiv.dataset.baseHeight = baseViewport.height;
            pageDiv.style.width = viewport.width + 'px';
            pageDiv.style.height = viewport.height + 'px';

            // Canvas
            var canvas = document.createElement('canvas');
            var ctx = canvas.getContext('2d');
            var dpr = window.devicePixelRatio || 1;
            canvas.width = viewport.width * dpr;
            canvas.height = viewport.height * dpr;
            canvas.style.width = viewport.width + 'px';
            canvas.style.height = viewport.height + 'px';
            ctx.scale(dpr, dpr);
            pageDiv.appendChild(canvas);

            // Text layer (transparent text for selection)
            var textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'textLayer';
            pageDiv.appendChild(textLayerDiv);

            viewer.appendChild(pageDiv);

            // Render canvas
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            if (generation !== renderGeneration || doc !== pdfDoc) return;

            // Render text layer
            try {
                var textContent = await page.getTextContent();
                pdfjsLib.renderTextLayer({
                    textContent: textContent,
                    container: textLayerDiv,
                    viewport: viewport,
                    textDivs: [],
                });
            } catch (_) {
                // text layer not critical — ignore if unavailable
            }

            // Annotation layer (clickable links, citations, cross-references)
            try {
                await renderAnnotationLayer(page, pageDiv, viewport);
            } catch (_) {
                // annotation layer not critical — ignore
            }
        }

        if (generation === renderGeneration && doc === pdfDoc) {
            renderedZoom = zoomLevel;
            if (restoreAnchor) restorePdfViewAnchor(restoreAnchor);
            updatePageIndicator();
        }
    } finally {
        rendering = false;
        if (pendingRender) {
            var anchor = pendingRenderAnchor || restoreAnchor;
            pendingRender = false;
            pendingRenderAnchor = null;
            await renderAllPages(anchor);
        }
    }
}

// ─── Annotation layer (links / citations / references) ───────────

async function renderAnnotationLayer(page, pageDiv, viewport) {
    var annotations = await page.getAnnotations();
    if (!annotations || annotations.length === 0) return;

    var annotDiv = document.createElement('div');
    annotDiv.className = 'annotationLayer';
    pageDiv.appendChild(annotDiv);

    for (var j = 0; j < annotations.length; j++) {
        var annot = annotations[j];
        if (annot.subtype !== 'Link') continue;
        if (!annot.rect) continue;

        // Convert PDF rect → viewport coordinates
        var rect = viewport.convertToViewportRectangle(annot.rect);
        // normalizeRect ensures [left, top, right, bottom]
        var bounds = pdfjsLib.Util.normalizeRect(rect);

        var link = document.createElement('a');
        link.className = 'pdf-link';
        link.style.left = bounds[0] + 'px';
        link.style.top = bounds[1] + 'px';
        link.style.width = (bounds[2] - bounds[0]) + 'px';
        link.style.height = (bounds[3] - bounds[1]) + 'px';

        if (annot.url) {
            // External URL (hyperref \url / \href)
            link.title = annot.url;
            link.dataset.url = annot.url;
            link.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({ type: 'openExternal', url: this.dataset.url });
            });
        } else if (annot.dest) {
            // Internal destination (citation, cross-reference, TOC)
            link.dataset.dest = typeof annot.dest === 'string'
                ? annot.dest : JSON.stringify(annot.dest);
            link.dataset.destType = typeof annot.dest === 'string' ? 'named' : 'explicit';
            link.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var dest = this.dataset.destType === 'named'
                    ? this.dataset.dest : JSON.parse(this.dataset.dest);
                navigateToDest(dest);
            });
        } else if (annot.action === 'GoTo' && annot.dest) {
            link.dataset.dest = typeof annot.dest === 'string'
                ? annot.dest : JSON.stringify(annot.dest);
            link.dataset.destType = typeof annot.dest === 'string' ? 'named' : 'explicit';
            link.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var dest = this.dataset.destType === 'named'
                    ? this.dataset.dest : JSON.parse(this.dataset.dest);
                navigateToDest(dest);
            });
        } else {
            // Unknown link type — skip
            continue;
        }

        annotDiv.appendChild(link);
    }
}

async function navigateToDest(dest) {
    if (!pdfDoc) return;

    try {
        // Named destinations need to be resolved first
        var destArray = dest;
        if (typeof dest === 'string') {
            destArray = await pdfDoc.getDestination(dest);
        }
        if (!destArray || !destArray[0]) return;

        // destArray[0] is a page ref object, resolve to page index
        var pageIndex = await pdfDoc.getPageIndex(destArray[0]);
        var targetPage = pageIndex + 1;

        var pages = viewer.querySelectorAll('.pdf-page');
        if (targetPage < 1 || targetPage > pages.length) return;

        var targetDiv = pages[targetPage - 1];

        // If dest specifies a Y position (e.g. [ref, /XYZ, x, y, z]),
        // scroll to that exact position within the page
        var destType = destArray[1];
        if (destType && destType.name === 'XYZ' && destArray[3] !== null) {
            var yPdf = destArray[3]; // Y in PDF coordinates (bottom-up)
            var page = await pdfDoc.getPage(targetPage);
            var vp = page.getViewport({ scale: zoomLevel });
            // Convert PDF Y (bottom-up) → viewport Y (top-down)
            var yViewport = vp.height - (yPdf * zoomLevel);
            var scrollTarget = targetDiv.offsetTop + Math.max(0, yViewport) - 20;
            viewerContainer.scrollTo({ top: scrollTarget, behavior: 'smooth' });
        } else {
            targetDiv.scrollIntoView({ behavior: 'smooth' });
        }
    } catch (_) {
        // Destination resolution failed — ignore
    }
}

// ─── Page indicator ──────────────────────────────────────────────

function updatePageIndicator() {
    var pages = viewer.querySelectorAll('.pdf-page');
    var top = viewerContainer.scrollTop;
    var center = top + viewerContainer.clientHeight / 2;
    for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        if (center >= p.offsetTop && center <= p.offsetTop + p.offsetHeight) {
            currentPage = parseInt(p.dataset.pageNum, 10);
            pageNum.textContent = currentPage;
            break;
        }
    }
}

viewerContainer.addEventListener('scroll', updatePageIndicator);

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function capturePdfViewAnchor() {
    var pages = viewer.querySelectorAll('.pdf-page');
    var centerY = viewerContainer.scrollTop + viewerContainer.clientHeight / 2;
    var maxScrollLeft = Math.max(1, viewerContainer.scrollWidth - viewerContainer.clientWidth);

    for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        var pageTop = p.offsetTop;
        var pageBottom = pageTop + p.offsetHeight;
        if (centerY >= pageTop && centerY <= pageBottom) {
            return {
                pageNumber: parseInt(p.dataset.pageNum, 10),
                pageOffsetRatio: p.offsetHeight > 0 ? (centerY - pageTop) / p.offsetHeight : 0,
                viewportOffsetY: viewerContainer.clientHeight / 2,
                scrollLeftRatio: viewerContainer.scrollLeft / maxScrollLeft,
                fallbackTop: viewerContainer.scrollTop,
            };
        }
    }

    return {
        pageNumber: currentPage,
        pageOffsetRatio: 0,
        viewportOffsetY: viewerContainer.clientHeight / 2,
        scrollLeftRatio: viewerContainer.scrollLeft / maxScrollLeft,
        fallbackTop: viewerContainer.scrollTop,
    };
}

function restorePdfViewAnchor(anchor) {
    if (!anchor) return;

    var pages = viewer.querySelectorAll('.pdf-page');
    if (pages.length === 0) {
        viewerContainer.scrollTop = anchor.fallbackTop || 0;
        return;
    }

    var targetPageNumber = clamp(anchor.pageNumber || 1, 1, pages.length);
    var targetPage = pages[targetPageNumber - 1];
    var pageOffsetRatio = clamp(anchor.pageOffsetRatio || 0, 0, 1);
    var desiredTop = targetPage.offsetTop + targetPage.offsetHeight * pageOffsetRatio - anchor.viewportOffsetY;
    var maxScrollTop = Math.max(0, viewerContainer.scrollHeight - viewerContainer.clientHeight);
    var maxScrollLeft = Math.max(0, viewerContainer.scrollWidth - viewerContainer.clientWidth);

    viewerContainer.scrollTop = clamp(desiredTop, 0, maxScrollTop);
    viewerContainer.scrollLeft = clamp((anchor.scrollLeftRatio || 0) * maxScrollLeft, 0, maxScrollLeft);
    updatePageIndicator();
}

// ─── Zoom helpers ────────────────────────────────────────────────

/**
 * Instantly resize existing page/canvas CSS dimensions without re-rendering.
 * The canvas bitmap stays the same (slightly blurry), but layout is correct.
 */
function quickResizePages() {
    var scaleRatio = zoomLevel / renderedZoom;
    var pages = viewer.querySelectorAll('.pdf-page');
    for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        var bw = parseFloat(p.dataset.baseWidth);
        var bh = parseFloat(p.dataset.baseHeight);
        if (!bw || !bh) continue;
        var w = bw * zoomLevel;
        var h = bh * zoomLevel;
        p.style.width = w + 'px';
        p.style.height = h + 'px';
        var canvas = p.querySelector('canvas');
        if (canvas) {
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
        }
        // Scale text & annotation layers to match the new zoom
        var layers = p.querySelectorAll('.textLayer, .annotationLayer');
        for (var j = 0; j < layers.length; j++) {
            var layer = layers[j];
            // Fix dimensions to the rendered size, then CSS-scale to new zoom
            layer.style.width = (bw * renderedZoom) + 'px';
            layer.style.height = (bh * renderedZoom) + 'px';
            layer.style.transform = 'scale(' + scaleRatio + ')';
            layer.style.transformOrigin = 'top left';
        }
    }
}

function getWheelDeltaPixels(e) {
    if (e.deltaMode === 1) return e.deltaY * 16;
    if (e.deltaMode === 2) return e.deltaY * viewerContainer.clientHeight;
    return e.deltaY;
}

function captureZoomAnchor(clientX, clientY) {
    var rect = viewerContainer.getBoundingClientRect();
    return {
        contentX: viewerContainer.scrollLeft + clientX - rect.left,
        contentY: viewerContainer.scrollTop + clientY - rect.top,
        viewportX: clientX - rect.left,
        viewportY: clientY - rect.top,
    };
}

function restoreZoomAnchor(anchor, oldZoom, newZoom) {
    if (!anchor || oldZoom <= 0) return;
    var scaleRatio = newZoom / oldZoom;
    viewerContainer.scrollLeft = Math.max(0, anchor.contentX * scaleRatio - anchor.viewportX);
    viewerContainer.scrollTop = Math.max(0, anchor.contentY * scaleRatio - anchor.viewportY);
}

function applyZoom(newZoom, immediate, anchor) {
    newZoom = Math.min(Math.max(newZoom, 0.1), 10.0);
    if (Math.abs(newZoom - zoomLevel) < 0.001) return;

    var oldZoom = zoomLevel;
    var scrollRatio = viewerContainer.scrollHeight > 0
        ? viewerContainer.scrollTop / viewerContainer.scrollHeight : 0;

    zoomLevel = newZoom;
    zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';

    if (immediate) {
        renderAllPages().then(function () {
            if (anchor) {
                restoreZoomAnchor(anchor, oldZoom, newZoom);
            } else {
                viewerContainer.scrollTop = scrollRatio * viewerContainer.scrollHeight;
            }
        });
        return;
    }

    // Instant CSS resize for smooth visual feedback
    quickResizePages();
    if (anchor) {
        restoreZoomAnchor(anchor, oldZoom, newZoom);
    } else {
        viewerContainer.scrollTop = scrollRatio * viewerContainer.scrollHeight;
    }

    // Debounce the expensive full-quality re-render
    if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = setTimeout(function () {
        zoomDebounceTimer = null;
        var r = viewerContainer.scrollHeight > 0
            ? viewerContainer.scrollTop / viewerContainer.scrollHeight : 0;
        renderAllPages().then(function () {
            if (anchor) {
                restoreZoomAnchor(anchor, oldZoom, newZoom);
            } else {
                viewerContainer.scrollTop = r * viewerContainer.scrollHeight;
            }
        });
    }, 300);
}

// Ctrl + scroll-wheel zoom
viewerContainer.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    var wheelDelta = getWheelDeltaPixels(e);
    var zoomFactor = Math.exp(-wheelDelta * 0.0025);
    var anchor = captureZoomAnchor(e.clientX, e.clientY);
    applyZoom(zoomLevel * zoomFactor, false, anchor);
}, { passive: false });

// ─── Recompile button ────────────────────────────────────────────

var recompileBtn = document.getElementById('recompile-btn');

recompileBtn.addEventListener('click', function () {
    if (recompileBtn.classList.contains('compiling')) return;
    vscode.postMessage({ type: 'recompile' });
});

function setCompilingState(compiling) {
    if (compiling) {
        recompileBtn.classList.add('compiling');
        recompileBtn.innerHTML = '<span class="spinner"></span>Compiling';
    } else {
        recompileBtn.classList.remove('compiling');
        recompileBtn.textContent = 'Recompile';
    }
}

// ─── Toolbar buttons ─────────────────────────────────────────────

document.getElementById('prev-page').addEventListener('click', function () {
    if (currentPage <= 1) return;
    var t = viewer.querySelectorAll('.pdf-page')[currentPage - 2];
    if (t) t.scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('next-page').addEventListener('click', function () {
    if (currentPage >= totalPages) return;
    var t = viewer.querySelectorAll('.pdf-page')[currentPage];
    if (t) t.scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('zoom-in').addEventListener('click', function () {
    applyZoom(zoomLevel + 0.25, true);
});
document.getElementById('zoom-out').addEventListener('click', function () {
    applyZoom(zoomLevel - 0.25, true);
});
document.getElementById('fit-width').addEventListener('click', async function () {
    if (!pdfDoc) return;
    var vp = (await pdfDoc.getPage(1)).getViewport({ scale: 1.0 });
    applyZoom((viewerContainer.clientWidth - 20) / vp.width, true);
});

// ─── Double-click → SyncTeX inverse search ───────────────────────

viewer.addEventListener('dblclick', function (e) {
    var target = e.target;
    var targetElement = target instanceof Element
        ? target
        : (target instanceof Node ? target.parentElement : null);
    if (!targetElement) return;

    var pageDiv = targetElement.closest('.pdf-page');
    if (!pageDiv) return;

    var pageNumber = parseInt(pageDiv.dataset.pageNum, 10);
    var rect = pageDiv.getBoundingClientRect();
    var clickX = e.clientX - rect.left;
    var clickY = e.clientY - rect.top;

    // Convert CSS pixels → PDF points (scale-1 units ≈ 1/72 inch)
    var pdfX = clickX / zoomLevel;
    var pdfY = clickY / zoomLevel;

    vscode.postMessage({ type: 'synctexClick', page: pageNumber, x: pdfX, y: pdfY });
});

// ─── Messages from extension ─────────────────────────────────────

window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type === 'updatePdf') {
        if (msg.pdfData) {
            loadPdfFromBase64(msg.pdfData);
        } else {
            loadPdf(msg.pdfUrl);
        }
    } else if (msg.type === 'setCompiling') {
        setCompilingState(msg.compiling);
    }
});
