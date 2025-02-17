let latencyChart;
let chartLabels = [];
let chartData = [];
let lastLatency = 0;
let isUpdating = false;
let lastSpikes = [];
const spikeHistorySize = 20;
let latencyValues = [];
let jitterValues = [];
let packetLossValues = [];
const maxHistoryLength = 100;

let updateInterval = 200; // Default update interval
let updateIntervalId = null;
let interpolationIntervalId = null;
let spikeHistoryIntervalId = null;
let jsReady = false;

eel.expose(async function set_data(latency, jitter, packetLoss) {
    document.getElementById('latency').innerText = latency;
    document.getElementById('jitter').innerText = jitter;
    document.getElementById('packetLoss').innerText = packetLoss;
});

document.addEventListener('DOMContentLoaded', () => {
    const latencyCtx = document.getElementById('latencyGraph').getContext('2d');

    // Increase window size and add padding points
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
                    max: totalPoints - paddingPoints,
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
            },
            maintainAspectRatio: false,
            responsive: true,
            plugins: {
                legend: {
                    display: false
                }
            }
        }
    });

    async function updateData() {
        if (!jsReady) return;
        if (isUpdating) return;
        isUpdating = true;

        try {
            const pingData = await eel.get_ping_data()();

            // Update current values
            document.getElementById('latency').innerText = pingData.latency;
            document.getElementById('jitter').innerText = pingData.jitter;
            document.getElementById('packetLoss').innerText = pingData.packetLoss;

            // Update history arrays for all metrics
            updateMetricHistory(latencyValues, pingData.latency);
            updateMetricHistory(jitterValues, pingData.jitter);
            updateMetricHistory(packetLossValues, pingData.packetLoss);

            // Update averages for all metrics
            updateAverage('latency', latencyValues, 'ms');
            updateAverage('jitter', jitterValues, 'ms');
            updateAverage('packetloss', packetLossValues, '%'); // Fixed class name to match HTML

            lastLatency = pingData.latency;
            await updateGraph(pingData.latency, false);
        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            isUpdating = false;
        }
    }

    function updateMetricHistory(array, value) {
        array.push(Number(value)); // Ensure value is a number
        if (array.length > maxHistoryLength) {
            array.shift();
        }
    }

    function updateAverage(metric, values, unit) {
        if (values.length === 0) return;

        const avg = values.reduce((a, b) => a + b) / values.length;
        const formattedAvg = avg.toFixed(1);

        const avgElement = document.querySelector(`.metric-${metric} .metric-avg`);
        if (avgElement) {
            avgElement.textContent = `avg: ${formattedAvg}${unit}`;
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

    function updateLastSpikes(latency) {
        const changeThreshold = 15;

        if (previousLatency !== 0 && latency - previousLatency > changeThreshold) {
            const spike = {
                value: latency,
                history: [latency]
            };

            lastSpikes.push(spike);
            if (lastSpikes.length > 5) {
                lastSpikes.shift();
            }

            displayLastSpikes();
        }

        previousLatency = latency;
    }

    function updateSpikeHistory(latency) {
        lastSpikes.forEach(spike => {
            spike.history.push(latency);
            if (spike.history.length > spikeHistorySize) {
                spike.history.shift();
            }
        });
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

            const spikeValue = document.createElement('span');
            spikeValue.classList.add('spike-value');
            spikeValue.textContent = `${spike.value.toFixed(1)} ms`;

            const graphContainer = document.createElement('div');
            graphContainer.classList.add('spike-graph-container');

            const spikeGraphCanvas = document.createElement('canvas');
            spikeGraphCanvas.classList.add('spike-graph');
            spikeGraphCanvas.width = 120;
            spikeGraphCanvas.height = 24;

            graphContainer.appendChild(spikeGraphCanvas);
            spikeCard.appendChild(spikeValue);
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
        console.log('Opening modal, current interval:', updateInterval);
    }

    function closeModal() {
        modal.classList.remove('show');
    }

    async function saveSettings() {
        const newInterval = Number(intervalInput.value);
        console.log('Attempting to save new interval:', newInterval);

        if (newInterval >= 100 && newInterval <= 2000) {
            updateInterval = newInterval;
            console.log('New interval saved:', updateInterval);

            try {
                // Update the Python interval
                await eel.set_interval(newInterval)();
                console.log('Python interval updated successfully');
            } catch (error) {
                console.error('Failed to update Python interval:', error);
            }

            restartIntervals();
            closeModal();
        } else {
            alert('Please enter a value between 100 and 2000 milliseconds');
        }
    }

    function restartIntervals() {
        console.log('Restarting intervals with new timing:', updateInterval);

        // Clear existing intervals
        if (updateIntervalId) {
            console.log('Clearing old update interval');
            clearInterval(updateIntervalId);
        }
        if (interpolationIntervalId) {
            console.log('Clearing old interpolation interval');
            clearInterval(interpolationIntervalId);
        }
        if (spikeHistoryIntervalId) {  // Clear the spike history interval
            console.log('Clearing old spike history interval');
            clearInterval(spikeHistoryIntervalId);
        }

        // Start new intervals with updated timing
        updateIntervalId = setInterval(() => {
            console.log('Update data called with interval:', updateInterval);
            updateData();
        }, updateInterval);

        interpolationIntervalId = setInterval(() => {
            interpolateLatency();
        }, updateInterval / 4);

        spikeHistoryIntervalId = setInterval(() => {   // Restart the spike history interval
            updateAllSpikeHistories(lastLatency);
        }, updateInterval);

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

    jsReady = true; // Mark JavaScript as ready
    eel.js_ready()(); // Signal to Python
    console.log("JavaScript initialized and signaled to Python.");

    restartIntervals(); // Start intervals
});