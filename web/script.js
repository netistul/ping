// script.js
let latencyChart;
let chartLabels = [];
let chartData = [];
let lastLatency = 0;
let isUpdating = false;
let lastSpikes = [];
const spikeHistorySize = 30;
let latencyValues = [];
let jitterValues = [];
let packetLossValues = [];
const maxHistoryLength = 100;

let updateInterval = 500;
let updateIntervalId = null;
let interpolationIntervalId = null;
let spikeHistoryIntervalId = null;
let jsReady = false;

// Trend detection configuration
let latencyTrends = [];
let previousLatencyValue = null;
const trendThreshold = 15;
const sustainedDuration = 1000; // 1 second
let activeTrend = null;

let qualityScoreHistory = [];
let monitoringStartTime = null;

let timeUpdateInterval = null;

let pywebviewReady = false;
const pywebviewReadyPromise = new Promise((resolve) => {
    // Check if pywebview is already available
    if (window.pywebview && window.pywebview.api) {
        pywebviewReady = true;
        resolve();
    } else {
        // Set up a handler for when pywebview becomes available
        window.addEventListener('pywebviewready', () => {
            pywebviewReady = true;
            resolve();
        });
    }
});

function updateMetrics(data) {
    const metrics = typeof data === 'string' ? JSON.parse(data) : data;

    updateDisplayValues(
        metrics.latency,
        metrics.jitter,
        metrics.packetLoss
    );

    // Add this line to update card colors
    updateMetricCardColors(metrics.latency);
}

function updateLatencyTrends(latency) {
    const now = Date.now();

    const baselineThreshold = 40;
    const minTrendDuration = 100;
    const maxTrendDuration = 10000; // Increased to 10 seconds
    const normalizedThreshold = 60; // Increased to better match typical variations
    const trendThreshold = 30; // Increased to reduce sensitivity to small changes

    if (previousLatencyValue !== null) {
        const difference = latency - previousLatencyValue;

        // Start new trend if we see a significant spike and no active trend
        if (!activeTrend && difference >= trendThreshold) {
            activeTrend = {
                startTime: now,
                startValue: previousLatencyValue,
                currentValue: latency,
                peakValue: latency,
                duration: 0,
                lastHighValue: now
            };
        }
        // Handle existing trend
        else if (activeTrend) {
            // Update peak if we find a higher value
            if (latency > activeTrend.peakValue) {
                const oldPeak = activeTrend.peakValue;
                activeTrend.peakValue = latency;
                activeTrend.lastHighValue = now;
            }

            const currentDuration = now - activeTrend.startTime;
            const timeSinceLastHigh = now - activeTrend.lastHighValue;

            // End trend if:
            // 1. Latency returns to baseline OR
            // 2. We've been below normalizedThreshold for 3 seconds OR
            // 3. Maximum trend duration exceeded AND we're below peak
            if (latency <= baselineThreshold ||
                (latency <= normalizedThreshold && timeSinceLastHigh >= 3000) ||
                (currentDuration >= maxTrendDuration && latency < activeTrend.peakValue * 0.8)) {

                if (currentDuration >= minTrendDuration &&
                    (activeTrend.peakValue - activeTrend.startValue >= trendThreshold)) {

                    const trend = {
                        from: Number(activeTrend.startValue.toFixed(1)),
                        to: Number(activeTrend.peakValue.toFixed(1)),
                        duration: currentDuration,
                        timestamp: new Date(activeTrend.startTime)
                    };

                    latencyTrends.push(trend);
                    while (latencyTrends.length > 10) {
                        latencyTrends.shift();
                    }

                    displayLatencyTrends();
                }

                activeTrend = null;
            }
        }
    }

    previousLatencyValue = latency;
}

function displayLatencyTrends() {
    const trendsElement = document.getElementById('latencyTrends');
    if (!trendsElement) {
        console.log('No trends element found!');
        return;
    }

    trendsElement.innerHTML = '';

    if (latencyTrends.length === 0) {
        console.log('No trends to display');
        trendsElement.innerHTML = '<div class="no-trends">No significant trends detected yet</div>';
        return;
    }

    latencyTrends.forEach(trend => {
        const trendCard = document.createElement('div');
        trendCard.classList.add('trend-card');

        const durationSeconds = (trend.duration / 1000).toFixed(2);

        const timeFormatted = trend.timestamp.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        trendCard.innerHTML = `
            <div class="trend-value">
                ${trend.from.toFixed(1)} → ${trend.to.toFixed(1)} ms
            </div>
            <div class="trend-info">
                <span class="trend-difference">+${(trend.to - trend.from).toFixed(1)} ms for ${durationSeconds}s</span>
                <span class="trend-time">${timeFormatted}</span>
            </div>
        `;

        trendsElement.prepend(trendCard);
    });
}

function calculateQualityScore(latency, jitter, packetLoss) {
    // Convert inputs to numbers
    latency = Number(latency);
    jitter = Number(jitter);
    packetLoss = Number(packetLoss);

    // Initialize timestamp tracking if not exists
    if (!window.metricTimestamps) {
        window.metricTimestamps = [];
    }
    window.metricTimestamps.push(Date.now());

    const scores = {
        currentLatency: 0,
        historicalPerformance: 0,
        spikes: 0,
        packetLoss: 0
    };

    // 1. Current Latency Score (25% weight)
    scores.currentLatency = Math.max(0, Math.min(100, (100 - latency) / 0.8));

    // 2. Historical Performance (25% weight)
    if (latencyValues.length > 0) {
        const weightedSum = latencyValues.reduce((sum, value, index) => {
            const weight = (index + 1) / latencyValues.length;
            return sum + (value * weight);
        }, 0);
        const weightedAvg = weightedSum / (latencyValues.length + 1) * 2;
        scores.historicalPerformance = Math.max(0, Math.min(100, (100 - weightedAvg) / 0.8));
    }

    // 3. Spike Analysis (30% weight)
    const baselineLatency = Math.min(...latencyValues, latency);

    let spikeImpact = 0;
    let spikeCounts = { small: 0, medium: 0, large: 0 };

    if (latencyValues.length > 0) {
        latencyValues.forEach((value, index) => {
            const deviation = value - baselineLatency;
            if (deviation > 0) {
                // Weight based on how recent and how severe
                const recency = (index + 1) / latencyValues.length;

                // Categorize spike
                if (deviation >= 50) spikeCounts.large++;
                else if (deviation >= 20) spikeCounts.medium++;
                else spikeCounts.small++;

                // Impact calculation:
                // - Small spikes (0-20ms): linear impact
                // - Medium spikes (20-50ms): squared impact
                // - Large spikes (50ms+): cubic impact
                const impact = deviation < 20 ?
                    deviation * 0.5 :
                    deviation < 50 ?
                        Math.pow(deviation, 1.5) * 0.1 :
                        Math.pow(deviation, 2) * 0.05;

                spikeImpact += impact * recency;
            }
        });

        // Current value impact
        const currentDeviation = latency - baselineLatency;
        if (currentDeviation > 0) {
            const currentImpact = currentDeviation < 20 ?
                currentDeviation * 0.5 :
                currentDeviation < 50 ?
                    Math.pow(currentDeviation, 1.5) * 0.1 :
                    Math.pow(currentDeviation, 2) * 0.05;
            spikeImpact += currentImpact * 2; // Double impact for current value

            if (currentDeviation >= 50) spikeCounts.large++;
            else if (currentDeviation >= 20) spikeCounts.medium++;
            else spikeCounts.small++;
        }

        scores.spikes = Math.max(0, 100 - (spikeImpact / 1000));
    }

    // 4. Packet Loss Score (20% weight)
    let weightedPacketLossScore = 100;
    if (packetLossValues.length > 0) {
        const recentLosses = packetLossValues.slice(-10);
        const historicalLosses = packetLossValues.slice(0, -10);

        const recentLossAvg = average(recentLosses) * 1.5;
        const historicalLossAvg = average(historicalLosses);

        const combinedLossImpact = (recentLossAvg + historicalLossAvg) / 2;
        weightedPacketLossScore = Math.max(0, 100 - (combinedLossImpact * 20));

    }
    scores.packetLoss = weightedPacketLossScore;

    // Calculate final weighted score
    const weights = {
        currentLatency: 0.25,
        historicalPerformance: 0.25,
        spikes: 0.30,
        packetLoss: 0.20
    };

    const finalScore = Math.round(
        scores.currentLatency * weights.currentLatency +
        scores.historicalPerformance * weights.historicalPerformance +
        scores.spikes * weights.spikes +
        scores.packetLoss * weights.packetLoss
    );

    return finalScore;
}

// Helper function for averaging
function average(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function updateMetricHistory(array, value) {
    const numValue = Number(value);
    if (!isNaN(numValue)) {
        array.push(numValue);
        // Removed this if block since we want to keep all values
        // if (array.length > maxHistoryLength) {
        //     array.shift();
        // }
    } else {
        console.warn(`Invalid value received: ${value}`);
    }
}


function updateAverage(metric, values, unit) {
    if (!values || values.length === 0) {
        console.warn(`No values available for ${metric}`);
        return;
    }

    const validValues = values.filter(v => !isNaN(v));
    if (validValues.length === 0) {
        console.warn(`No valid numbers for ${metric}`);
        return;
    }

    const avg = validValues.reduce((a, b) => a + b, 0) / validValues.length;
    const formattedAvg = avg.toFixed(1);

    const avgElement = document.querySelector(`.metric-${metric} .metric-avg`);
    if (avgElement) {
        avgElement.textContent = `avg: ${formattedAvg}${unit}`;
    } else {
        console.error(`Average element not found for: .metric-${metric} .metric-avg`);
    }
}

function updateElapsedTimeDisplay() {
    const elapsedTimeElement = document.getElementById('elapsed-time'); // Changed from 'monitoringTime'
    if (elapsedTimeElement && monitoringStartTime) {
        console.log('Updating elapsed time:', getElapsedTimeText()); // Add logging
        elapsedTimeElement.textContent = getElapsedTimeText();
    } else {
        console.log('Element or start time missing:', {
            element: !!elapsedTimeElement,
            startTime: !!monitoringStartTime
        });
    }
}

function getElapsedTimeText() {
    if (!monitoringStartTime) return "just started";

    const now = new Date();
    const elapsedMs = now - monitoringStartTime;
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    if (elapsedMinutes < 1) {
        return "just started";
    } else if (elapsedMinutes === 1) {
        return "last 1 minute";
    } else if (elapsedMinutes < 60) {
        return `last ${elapsedMinutes} minutes`;
    } else {
        const hours = Math.floor(elapsedMinutes / 60);
        const remainingMinutes = elapsedMinutes % 60;
        if (remainingMinutes === 0) {
            return `last ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
        } else {
            return `last ${hours} ${hours === 1 ? 'hour' : 'hours'} ${remainingMinutes} ${remainingMinutes === 1 ? 'minute' : 'minutes'}`;
        }
    }
}

function updateDisplayValues(latency, jitter, packetLoss) {
    if (!jsReady) return;

    // Update basic metrics
    document.getElementById('latency').innerText = latency;
    document.getElementById('jitter').innerText = jitter;
    document.getElementById('packetLoss').innerText = packetLoss;

    // Update history arrays first, so they're available for quality score calculation
    updateMetricHistory(latencyValues, latency);
    updateMetricHistory(jitterValues, jitter);
    updateMetricHistory(packetLossValues, packetLoss);

    // Calculate and update quality score (now uses historical values)
    const qualityScore = calculateQualityScore(latency, jitter, packetLoss);
    updateMetricHistory(qualityScoreHistory, qualityScore);

    // Update quality score display
    const qualityScoreElement = document.getElementById('qualityScore');
    if (qualityScoreElement) {
        qualityScoreElement.innerText = qualityScore;
    } else {
        console.error('Quality score element not found!');
    }

    // Update quality score indicator class
    const qualityCard = document.querySelector('.metric-quality');
    if (qualityCard) {
        qualityCard.classList.remove('excellent', 'good', 'fair', 'poor');
        if (qualityScore >= 90) qualityCard.classList.add('excellent');
        else if (qualityScore >= 70) qualityCard.classList.add('good');
        else if (qualityScore >= 50) qualityCard.classList.add('fair');
        else qualityCard.classList.add('poor');
    }

    // Update averages using your existing updateAverage function
    updateAverage('latency', latencyValues, 'ms');
    updateAverage('jitter', jitterValues, 'ms');
    updateAverage('packetloss', packetLossValues, '%');
    updateAverage('quality', qualityScoreHistory, '');

    // Show history size in UI if needed
    const historyCountElement = document.getElementById('historyCount');
    if (historyCountElement) {
        historyCountElement.innerText = latencyValues.length;
    }

    lastLatency = latency;
    if (typeof updateGraph === 'function') {
        updateGraph(latency, false);
    }

    updateLatencyTrends(latency);
}

// Optional: Add stability calculation function
function calculateStability() {
    if (latencyValues.length < 10) return "Insufficient data";

    const latencyStdDev = calculateStandardDeviation(latencyValues);
    const jitterStdDev = calculateStandardDeviation(jitterValues);

    // Combined stability score (lower is more stable)
    const stabilityScore = (latencyStdDev + jitterStdDev) / 2;

    if (stabilityScore < 5) return "Very stable";
    if (stabilityScore < 15) return "Stable";
    if (stabilityScore < 30) return "Moderate";
    return "Unstable";
}

function calculateStandardDeviation(values) {
    const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squareDiffs = values.map(value => {
        const diff = value - avg;
        return diff * diff;
    });
    const avgSquareDiff = squareDiffs.reduce((sum, val) => sum + val, 0) / squareDiffs.length;
    return Math.sqrt(avgSquareDiff);
}

function updateMetricCardColors(latency) {
    const metricCards = document.querySelectorAll('.metric-card');

    // Remove existing latency classes
    metricCards.forEach(card => {
        card.classList.remove('latency-normal', 'latency-medium', 'latency-high', 'latency-critical');
    });

    // Determine latency level
    let latencyClass = 'latency-normal';
    if (latency > 100) {
        latencyClass = 'latency-critical';
    } else if (latency > 70) {
        latencyClass = 'latency-high';
    } else if (latency > 50) {
        latencyClass = 'latency-medium';
    }

    // Apply new class to all cards
    metricCards.forEach(card => {
        card.classList.add(latencyClass);
    });
}

// Make updateDisplayValues available globally
window.updateDisplayValues = updateDisplayValues;

let isMaximized = false;

function minimizeWindow() {
    pywebview.api.minimize_window();
}

function toggleMaximize() {
    if (isMaximized) {
        pywebview.api.restore_window();
    } else {
        pywebview.api.maximize_window();
    }
    isMaximized = !isMaximized;
}

function closeWindow() {
    pywebview.api.close_window();
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log("DOM loaded, starting initialization...");

        // Set up chart and other components first
        const latencyCtx = document.getElementById('latencyGraph').getContext('2d');
        monitoringStartTime = new Date();

        // Initialize chart data
        const visiblePoints = 50;
        const paddingPoints = 10;
        const totalPoints = visiblePoints + paddingPoints;

        // Pre-fill arrays with timestamps and values including padding
        const now = new Date();
        for (let i = 0; i < totalPoints; i++) {
            const time = new Date(now - (totalPoints - i) * 200);
            chartLabels.push(
                time.getHours().toString().padStart(2, '0') + ':' +
                time.getMinutes().toString().padStart(2, '0') + ':' +
                time.getSeconds().toString().padStart(2, '0')
            );
            chartData.push(0);
        }

        // Initialize chart configuration...
        latencyChart = new Chart(latencyCtx, {
            type: 'line',
            data: {
                labels: chartLabels,
                datasets: [{
                    label: 'Latency (ms)',
                    data: chartData,
                    borderColor: '#61afef',
                    borderWidth: 2,
                    fill: true,
                    backgroundColor: 'rgba(97, 175, 239, 0.1)',
                    tension: 0.4,
                    pointRadius: 0,
                    pointHitRadius: 10
                }]
            },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        enabled: true,
                        position: 'nearest',
                        backgroundColor: 'rgba(20, 20, 20, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        titleFont: {
                            size: 13,
                            weight: '500',
                            family: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
                        },
                        bodyFont: {
                            size: 12,
                            family: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
                        },
                        padding: {
                            x: 12,
                            y: 8
                        },
                        cornerRadius: 6,
                        displayColors: false,
                        callbacks: {
                            title: function (tooltipItems) {
                                return tooltipItems[0].label;
                            },
                            label: function (context) {
                                return `Latency: ${context.parsed.y.toFixed(1)} ms`;
                            }
                        }
                    }
                },
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        suggestedMax: 100,
                        grid: {
                            color: 'rgba(200, 200, 200, 0.1)',
                            drawBorder: false
                        }
                    },
                    x: {
                        min: paddingPoints,
                        max: totalPoints - 1,
                        grid: {
                            display: false
                        },
                        ticks: {
                            maxTicksLimit: 8,
                            maxRotation: 0,
                            callback: function (value, index) {
                                if (index >= paddingPoints && index < totalPoints - paddingPoints) {
                                    return this.getLabelForValue(value);
                                }
                                return '';
                            }
                        }
                    }
                },
                animation: {
                    duration: 100,
                    easing: 'linear'
                }
            }
        });

        async function updateData() {
            if (!jsReady || isUpdating) return;
            isUpdating = true;

            try {
                // Check if we're in "mock" mode (no Python backend)
                const isMockMode = !window.pywebview ||
                    !window.pywebview.api ||
                    typeof window.pywebview.api.get_ping_data !== 'function';

                if (isMockMode) {
                    // Generate mock data for testing the UI
                    const mockData = {
                        latency: Math.round((Math.random() * 20 + 20) * 10) / 10,
                        jitter: Math.round((Math.random() * 5 + 1) * 10) / 10,
                        packetLoss: Math.round(Math.random() * 20) / 10
                    };
                    updateDisplayValues(mockData.latency, mockData.jitter, mockData.packetLoss);
                    lastLatency = mockData.latency;
                    await updateGraph(mockData.latency, false);
                } else {
                    // Real API mode
                    const pingDataStr = await window.pywebview.api.get_ping_data();
                    const pingData = JSON.parse(pingDataStr);
                    updateDisplayValues(pingData.latency, pingData.jitter, pingData.packetLoss);
                    lastLatency = pingData.latency;
                    await updateGraph(pingData.latency, false);
                }
            } catch (error) {
                console.error('Error fetching data:', error);
            } finally {
                isUpdating = false;
            }
        }

        function interpolateLatency() {
            if (!isUpdating && lastLatency !== 0) {
                const variation = (Math.random() - 0.5) * 2;
                const interpolatedValue = lastLatency + variation;
                updateGraph(interpolatedValue, true);
            }
        }

        function updateGraph(latency, isInterpolated) {
            const now = new Date();
            const time = now.getHours().toString().padStart(2, '0') + ':' +
                now.getMinutes().toString().padStart(2, '0') + ':' +
                now.getSeconds().toString().padStart(2, '0');

            chartLabels.shift();
            chartData.shift();
            chartLabels.push(time);
            chartData.push(latency);

            latencyChart.update(isInterpolated ? 'none' : 'default');

            updateLastSpikes(latency);
        }

        let previousLatency = 0;

        // Track the current spike event
        let activeSpike = null;
        const SPIKE_COOLDOWN = 5000; // 5 seconds minimum between new spike recordings
        const SPIKE_UPDATE_THRESHOLD = 1.1; // 10% increase needed to update existing spike
        const MINIMUM_SPIKE_VALUE = 45; // Absolute minimum value to be considered a spike
        const WARMUP_SAMPLES = 10; // Number of samples needed before detecting spikes

        function updateLastSpikes(latency) {
            const baselineThreshold = 30;  // Normal latency threshold
            const spikeThreshold = 1.8;    // Multiplier for spike detection

            // Wait for enough samples before starting spike detection
            if (chartData.filter(v => v > 0).length < WARMUP_SAMPLES) {
                return;
            }

            // Calculate moving average for baseline (last 10 values)
            const recentValues = chartData.slice(-10).filter(v => v > 0);
            if (recentValues.length === 0) return;

            const baselineLatency = recentValues.reduce((sum, val) => sum + val, 0) / recentValues.length;

            const now = new Date();
            // Add minimum value check to spike detection
            const isSpike = (latency > baselineLatency * spikeThreshold || latency > baselineThreshold * 2)
                && latency >= MINIMUM_SPIKE_VALUE;

            // Handle active spike event
            if (activeSpike) {
                // Update active spike if we find a higher value
                if (latency > activeSpike.value * SPIKE_UPDATE_THRESHOLD) {
                    activeSpike.value = latency;
                    activeSpike.history = chartData.slice(-spikeHistorySize);
                    activeSpike.timestamp = now;
                    displayLastSpikes();
                }

                // End active spike if latency returns near baseline
                if (latency <= baselineLatency * 1.2) {
                    activeSpike = null;
                }
                // Or if it's been too long since the spike started
                else if (now - activeSpike.timestamp > SPIKE_COOLDOWN) {
                    activeSpike = null;
                }
            }
            // Start new spike event
            else if (isSpike) {
                // Check if enough time has passed since last spike
                const lastSpike = lastSpikes[0];
                if (!lastSpike || now - lastSpike.timestamp > SPIKE_COOLDOWN) {
                    activeSpike = {
                        value: latency,
                        baseline: baselineLatency,
                        history: chartData.slice(-spikeHistorySize),
                        timestamp: now
                    };

                    lastSpikes.unshift(activeSpike);
                    if (lastSpikes.length > 30) {
                        lastSpikes.pop();
                    }

                    displayLastSpikes();
                }
            }

            previousLatency = latency;
        }

        // Helper function to get formatted duration
        function getSpikeDuration(timestamp) {
            const now = new Date();
            const duration = now - timestamp;
            if (duration < 1000) return 'just now';
            if (duration < 60000) return `${Math.floor(duration / 1000)}s ago`;
            return `${Math.floor(duration / 60000)}m ago`;
        }

        function updateSpikeHistory(latency) {
            if (lastSpikes.length > 0) {
                // Only update the most recent spike
                const mostRecentSpike = lastSpikes[lastSpikes.length - 1];
                mostRecentSpike.history.push(latency);
                if (mostRecentSpike.history.length > spikeHistorySize) {
                    mostRecentSpike.history.shift();
                }
            }
        }

        function createSparkline(canvas, data) {
            const ctx = canvas.getContext('2d');
            const width = canvas.width;
            const height = canvas.height;

            ctx.clearRect(0, 0, width, height);

            const maxValue = Math.max(...data);
            const minValue = Math.min(...data);
            const range = maxValue - minValue || 1;

            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            const gradient = ctx.createLinearGradient(0, 0, 0, height);
            gradient.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
            gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

            ctx.beginPath();
            ctx.moveTo(0, height);

            data.forEach((value, index) => {
                const x = (index / (data.length - 1)) * width;
                const normalizedValue = (value - minValue) / range;
                const y = height - (normalizedValue * (height * 0.8));

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });

            ctx.lineTo(width, height);
            ctx.lineTo(0, height);

            ctx.fillStyle = gradient;
            ctx.fill();

            ctx.beginPath();
            data.forEach((value, index) => {
                const x = (index / (data.length - 1)) * width;
                const normalizedValue = (value - minValue) / range;
                const y = height - (normalizedValue * (height * 0.8));

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
            ctx.stroke();

            const lastValue = data[data.length - 1];
            const lastX = width;
            const lastY = height - ((lastValue - minValue) / range * (height * 0.8));

            ctx.beginPath();
            ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
            ctx.fillStyle = 'white';
            ctx.fill();
        }

        function displayLastSpikes() {
            const lastSpikesCardsElement = document.getElementById('lastSpikesCards');
            lastSpikesCardsElement.innerHTML = '';

            lastSpikes.forEach((spike) => {
                const spikeCard = document.createElement('div');
                spikeCard.classList.add('spike-card');

                if (spike.value < 40) {
                    spikeCard.classList.add('low');
                } else if (spike.value < 100) {
                    spikeCard.classList.add('medium');
                } else {
                    spikeCard.classList.add('high');
                }

                const valueContainer = document.createElement('div');
                valueContainer.classList.add('spike-value');

                const valueText = document.createElement('span');
                valueText.textContent = `${spike.value.toFixed(1)} ms`;
                valueContainer.appendChild(valueText);

                const timeIndicator = document.createElement('div');
                timeIndicator.classList.add('time-indicator');

                const clockIcon = document.createElement('span');
                clockIcon.classList.add('clock-icon');
                clockIcon.innerHTML = '&#128339;';
                timeIndicator.appendChild(clockIcon);

                const timeText = document.createElement('span');
                timeText.textContent = getSpikeDuration(spike.timestamp);
                timeIndicator.appendChild(timeText);

                valueContainer.appendChild(timeIndicator);

                // Show if this is an active spike
                if (spike === activeSpike) {
                    const activeIndicator = document.createElement('div');
                    activeIndicator.classList.add('active-indicator');
                    activeIndicator.textContent = '● Active';
                    valueContainer.appendChild(activeIndicator);
                }

                const graphContainer = document.createElement('div');
                graphContainer.classList.add('spike-graph-container');

                const spikeGraphCanvas = document.createElement('canvas');
                spikeGraphCanvas.classList.add('spike-graph');
                spikeGraphCanvas.width = 40;
                spikeGraphCanvas.height = 16;

                graphContainer.appendChild(spikeGraphCanvas);
                spikeCard.appendChild(valueContainer);
                spikeCard.appendChild(graphContainer);
                lastSpikesCardsElement.appendChild(spikeCard);

                createSparkline(spikeGraphCanvas, spike.history);
            });
        }

        function updateAllSpikeHistories(latency) {
            updateSpikeHistory(latency);
            displayLastSpikes();
        }


        // Settings Modal Controls
        const modal = document.getElementById('settingsModal');
        const openButton = document.getElementById('openSettings');
        const closeButton = document.getElementById('closeSettings');
        const saveButton = document.getElementById('saveSettings');
        const intervalInput = document.getElementById('pingInterval');

        function openModal() {
            modal.classList.add('show');
            intervalInput.value = updateInterval;
        }

        function closeModal() {
            modal.classList.remove('show');
        }

        async function saveSettings() {
            const saveButton = document.getElementById('saveSettings');
            const buttonText = saveButton.querySelector('.button-text');
            const spinner = saveButton.querySelector('.spinner');
            const newInterval = Number(intervalInput.value);

            if (newInterval >= 100 && newInterval <= 2000) {
                try {
                    // Check if pywebview is available
                    if (typeof window.pywebview === 'undefined') {
                        alert('Settings cannot be saved: system not ready');
                        return;
                    }

                    // Show loading state
                    saveButton.disabled = true;
                    saveButton.classList.add('loading');
                    spinner.classList.remove('hidden');

                    // Update the Python interval using pywebview
                    const response = await window.pywebview.api.set_interval(newInterval);
                    const result = JSON.parse(response);

                    if (result.success) {
                        updateInterval = newInterval;
                        // Wait a moment to ensure the change has taken effect
                        await new Promise(resolve => setTimeout(resolve, 500));
                        restartIntervals();
                        closeModal();
                    }
                } catch (error) {
                    console.error('Failed to update interval:', error);
                    alert('Failed to update interval. Please try again.');
                } finally {
                    // Reset button state
                    saveButton.disabled = false;
                    saveButton.classList.remove('loading');
                    spinner.classList.add('hidden');
                }
            } else {
                alert('Please enter a value between 100 and 2000 milliseconds');
            }
        }

        function restartIntervals() {
            // Clear existing intervals
            if (updateIntervalId) {
                clearInterval(updateIntervalId);
            }
            if (interpolationIntervalId) {
                clearInterval(interpolationIntervalId);
            }
            if (spikeHistoryIntervalId) {
                clearInterval(spikeHistoryIntervalId);
            }
            if (timeUpdateInterval) {
                clearInterval(timeUpdateInterval);
            }

            // Start new intervals with updated timing
            updateIntervalId = setInterval(() => {
                updateData();
            }, updateInterval);

            interpolationIntervalId = setInterval(() => {
                interpolateLatency();
            }, updateInterval / 4);

            spikeHistoryIntervalId = setInterval(() => {
                updateAllSpikeHistories(lastLatency);
            }, updateInterval);

            // Add the time update interval
            timeUpdateInterval = setInterval(() => {
                updateElapsedTimeDisplay();
            }, 60000);

            console.log('New intervals set up');
        }

        openButton.addEventListener('click', openModal);
        closeButton.addEventListener('click', closeModal);
        saveButton.addEventListener('click', saveSettings);

        // Close modal if clicked outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        jsReady = true;
        console.log("JS components initialized, setting jsReady = true");

        // Now wait for pywebview with a timeout to prevent infinite waiting
        let attempts = 0;
        const maxAttempts = 20;

        const waitForPywebview = async () => {
            if (window.pywebview && window.pywebview.api) {
                console.log("PyWebView detected, checking API functions...");

                // Debug: List available API methods
                const apiMethods = Object.getOwnPropertyNames(window.pywebview.api)
                    .filter(prop => typeof window.pywebview.api[prop] === 'function');
                console.log("Available API methods:", apiMethods);

                // Check if our expected functions are available
                const hasJsReady = typeof window.pywebview.api.js_ready === 'function';

                if (hasJsReady) {
                    try {
                        await window.pywebview.api.js_ready();
                    } catch (err) {
                        console.error("Error calling js_ready:", err);
                    }
                } else {
                    console.warn("js_ready function not found in API");
                }

                pywebviewReady = true;
                restartIntervals();
            } else if (attempts < maxAttempts) {
                attempts++;
                console.log(`Waiting for PyWebView API... (${attempts}/${maxAttempts})`);
                setTimeout(waitForPywebview, 200);
            } else {
                console.error("PyWebView not available after maximum attempts");
                restartIntervals();
            }
        };

        // Start the waiting process
        waitForPywebview();

    } catch (error) {
        console.error('Error during initialization:', error);
    }
});

