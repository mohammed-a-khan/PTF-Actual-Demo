/**
 * CSCustomCharts - Embedded Version for HTML Reports
 * A lightweight, feature-rich charting library built from scratch
 */

interface ChartConfig {
    type: 'doughnut' | 'pie' | 'bar' | 'line';
    data: ChartData;
    options?: ChartOptions;
}

interface ChartData {
    labels: string[];
    datasets: ChartDataset[];
}

interface ChartDataset {
    label?: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string | string[];
    borderWidth?: number;
    yAxisID?: string;
    tension?: number;
    fill?: boolean;
}

interface ChartOptions {
    responsive?: boolean;
    maintainAspectRatio?: boolean;
    animation?: {
        duration?: number;
        easing?: string;
    };
    plugins?: {
        legend?: {
            display?: boolean;
            position?: 'top' | 'bottom' | 'left' | 'right';
        };
        datalabels?: {
            display?: boolean;
            color?: string;
            font?: {
                size?: number;
                weight?: string;
            };
        };
        tooltip?: {
            callbacks?: {
                label?: (context: any) => string;
            };
        };
    };
    scales?: {
        x?: {
            stacked?: boolean;
            ticks?: {
                maxRotation?: number;
            };
        };
        y?: any;
        y1?: any;
    };
}

interface ChartArea {
    x: number;
    y: number;
    width: number;
    height: number;
}

declare global {
    interface Window {
        CSChart: typeof CSChart;
    }
}

class CSChart {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private type: string;
    private data: ChartData;
    private options: ChartOptions;
    private animationFrame: number = 0;
    private currentAnimation: number = 0;
    private tooltipElement: HTMLDivElement | null = null;
    private hoveredSegment: number = -1;
    private chartArea: ChartArea = { x: 0, y: 0, width: 0, height: 0 };
    private legendArea: ChartArea = { x: 0, y: 0, width: 0, height: 0 };
    private animationProgress: number = 0;
    private isAnimating: boolean = false;

    constructor(canvas: HTMLCanvasElement, config: ChartConfig) {
        this.canvas = canvas;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Failed to get 2D context from canvas');
        }
        this.ctx = context;
        this.type = config.type;
        this.data = config.data;
        this.options = Object.assign({
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 1000,
                easing: 'easeOutQuart'
            }
        }, config.options || {});

        // Set canvas size
        this.resizeCanvas();

        // Calculate chart and legend areas
        this.calculateAreas();

        // Setup event listeners
        this.setupEventListeners();

        // Start animation and rendering
        this.startAnimation();
    }

    private resizeCanvas(): void {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = rect.width || this.canvas.offsetWidth;
        this.canvas.height = rect.height || this.canvas.offsetHeight;
    }

    private calculateAreas(): void {
        const padding = 20;
        const legendPosition = (this.options.plugins?.legend?.position) || 'bottom';

        // Calculate legend dimensions based on position
        let legendWidth = 0;
        let legendHeight = 0;

        if (this.options.plugins?.legend?.display !== false) {
            if (legendPosition === 'right') {
                // Adaptive legend width based on canvas size
                legendWidth = Math.min(250, this.canvas.width * 0.35);  // Max 35% of canvas width for better text visibility
            } else {
                // For bottom legend or bar charts with rotated labels
                const needsExtraSpace = this.type === 'bar' && this.options.scales?.x?.ticks?.maxRotation;
                legendHeight = needsExtraSpace ? 120 : 60;  // More space for rotated labels
            }
        }

        // Calculate chart area based on legend position
        if (legendPosition === 'right') {
            // Ensure chart uses most of the available space
            this.chartArea = {
                x: padding,
                y: padding,
                width: this.canvas.width - padding * 2 - legendWidth,
                height: this.canvas.height - padding * 2
            };
            this.legendArea = {
                x: this.canvas.width - legendWidth + 10,  // Small gap from chart
                y: padding,
                width: legendWidth - padding - 10,
                height: this.canvas.height - padding * 2
            };
        } else {
            this.chartArea = {
                x: padding,
                y: padding,
                width: this.canvas.width - padding * 2,
                height: this.canvas.height - padding * 2 - legendHeight - 30 // Extra space for x-axis labels
            };
            this.legendArea = {
                x: padding,
                y: this.canvas.height - legendHeight,
                width: this.canvas.width - padding * 2,
                height: legendHeight
            };
        }
    }

    private setupEventListeners(): void {
        // Mouse move for hover effects
        this.canvas.addEventListener('mousemove', (e: MouseEvent) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
            const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
            this.handleMouseMove(x, y);
        });

        // Mouse leave to hide tooltip
        this.canvas.addEventListener('mouseleave', () => {
            this.hideTooltip();
            this.hoveredSegment = -1;
            this.render();
        });

        // Window resize
        const resizeHandler = () => {
            this.resizeCanvas();
            this.calculateAreas();
            this.render();
        };
        window.addEventListener('resize', resizeHandler);
    }

    private easeOutQuart(t: number): number {
        return 1 - Math.pow(1 - t, 4);
    }

    private startAnimation(): void {
        this.isAnimating = true;
        const startTime = Date.now();
        const duration = this.options.animation?.duration || 1000;

        const animate = () => {
            const currentTime = Date.now();
            const elapsed = currentTime - startTime;
            this.animationProgress = Math.min(elapsed / duration, 1);

            if (this.options.animation?.easing === 'easeOutQuart') {
                this.animationProgress = this.easeOutQuart(this.animationProgress);
            }

            this.render();

            if (this.animationProgress < 1) {
                requestAnimationFrame(animate);
            } else {
                this.isAnimating = false;
            }
        };

        animate();
    }

    private render(): void {
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Render based on chart type
        switch (this.type) {
            case 'doughnut':
            case 'pie':
                this.renderDoughnutChart();
                break;
            case 'bar':
                this.renderBarChart();
                break;
            case 'line':
                this.renderLineChart();
                break;
        }

        // Render legend
        if (this.options.plugins?.legend?.display !== false) {
            this.renderLegend();
        }
    }

    private renderDoughnutChart(): void {
        const centerX = this.chartArea.x + this.chartArea.width / 2;
        const centerY = this.chartArea.y + this.chartArea.height / 2;
        // Use almost all available space for the chart
        const maxRadius = Math.min(this.chartArea.width, this.chartArea.height) / 2;
        // Ensure radius is never negative
        const radius = Math.max(10, maxRadius * 0.85); // Use 85% of available space, minimum 10px
        const innerRadius = this.type === 'doughnut' ? Math.max(0, radius * 0.5) : 0; // 50% inner radius for doughnut, never negative

        const dataset = this.data.datasets[0];
        const total = dataset.data.reduce((a, b) => a + b, 0);
        let currentAngle = -Math.PI / 2;

        // Draw segments with animation - FULL CIRCLE
        dataset.data.forEach((value, index) => {
            const sliceAngle = (value / total) * Math.PI * 2; // Full slice angle
            const animatedEndAngle = currentAngle + (sliceAngle * this.animationProgress);

            // Draw segment
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, radius, currentAngle, animatedEndAngle);
            this.ctx.arc(centerX, centerY, innerRadius, animatedEndAngle, currentAngle, true);
            this.ctx.closePath();

            // Apply color
            const colors = Array.isArray(dataset.backgroundColor)
                ? dataset.backgroundColor
                : [dataset.backgroundColor || '#000'];
            this.ctx.fillStyle = colors[index % colors.length];

            // Apply hover effect
            if (this.hoveredSegment === index) {
                this.ctx.save();
                this.ctx.shadowColor = 'rgba(0,0,0,0.3)';
                this.ctx.shadowBlur = 10;
                this.ctx.shadowOffsetX = 2;
                this.ctx.shadowOffsetY = 2;
                // Scale up slightly
                this.ctx.translate(centerX, centerY);
                this.ctx.scale(1.05, 1.05);
                this.ctx.translate(-centerX, -centerY);
            }

            this.ctx.fill();

            if (this.hoveredSegment === index) {
                this.ctx.restore();
            }

            // Draw border
            if (dataset.borderWidth) {
                this.ctx.strokeStyle = Array.isArray(dataset.borderColor)
                    ? dataset.borderColor[index % dataset.borderColor.length]
                    : dataset.borderColor || '#fff';
                this.ctx.lineWidth = dataset.borderWidth;
                this.ctx.stroke();
            }

            // Draw data labels (only after animation completes)
            if (this.animationProgress >= 1 && this.options.plugins?.datalabels?.display !== false) {
                const percentageValue = (value / total) * 100;
                // Skip labels for 0% values
                if (percentageValue >= 0.5) {
                    const labelAngle = currentAngle + sliceAngle / 2;
                    const labelRadius = innerRadius + (radius - innerRadius) / 2;
                    const labelX = centerX + Math.cos(labelAngle) * labelRadius;
                    const labelY = centerY + Math.sin(labelAngle) * labelRadius;

                    const percentage = percentageValue.toFixed(1) + '%';

                    this.ctx.fillStyle = this.options.plugins?.datalabels?.color || '#fff';
                    const fontSize = this.options.plugins?.datalabels?.font?.size || 20; // Much larger font
                    const fontWeight = this.options.plugins?.datalabels?.font?.weight || 'bold';
                    this.ctx.font = `${fontWeight} ${fontSize}px Arial`;
                    this.ctx.textAlign = 'center';
                    this.ctx.textBaseline = 'middle';

                    // Add text shadow for better readability
                    this.ctx.save();
                    this.ctx.shadowColor = 'rgba(0,0,0,0.5)';
                    this.ctx.shadowBlur = 3;
                    this.ctx.fillText(percentage, labelX, labelY);
                    this.ctx.restore();
                }
            }

            currentAngle += sliceAngle; // Move to next slice position
        });
    }

    private renderBarChart(): void {
        const datasets = this.data.datasets;
        const barCount = this.data.labels.length;
        const isStacked = this.options.scales?.x?.stacked;

        // Calculate bar dimensions
        const totalBarWidth = this.chartArea.width / barCount;
        const barGroupWidth = totalBarWidth * 0.7;
        const barSpacing = totalBarWidth * 0.3;

        // Calculate max value for scale
        let maxValue = 0;
        if (isStacked) {
            // For stacked bars, max is the sum of all datasets at each index
            for (let i = 0; i < barCount; i++) {
                let stackSum = 0;
                datasets.forEach(dataset => {
                    stackSum += dataset.data[i] || 0;
                });
                maxValue = Math.max(maxValue, stackSum);
            }
        } else {
            // For non-stacked, max is the highest individual value
            datasets.forEach(dataset => {
                const dataMax = Math.max(...dataset.data);
                maxValue = Math.max(maxValue, dataMax);
            });
        }

        // Draw grid lines
        this.drawGrid(maxValue);

        // Draw bars for each label position
        for (let labelIndex = 0; labelIndex < barCount; labelIndex++) {
            const x = this.chartArea.x + labelIndex * totalBarWidth + barSpacing / 2;

            if (isStacked) {
                // Draw stacked bars - iterate through datasets and stack them
                let stackedHeight = 0;
                let totalValue = 0;

                datasets.forEach((dataset, datasetIndex) => {
                    const value = dataset.data[labelIndex] || 0;
                    const animatedValue = value * this.animationProgress;
                    const barHeight = (animatedValue / maxValue) * (this.chartArea.height - 80);

                    if (barHeight > 0) {
                        // Calculate Y position from bottom, accounting for previous bars
                        const barY = this.chartArea.y + this.chartArea.height - 60 - stackedHeight - barHeight;

                        // Draw bar segment
                        this.ctx.fillStyle = dataset.backgroundColor as string || '#3b82f6';
                        this.roundRect(x, barY, barGroupWidth, barHeight, 2);
                        this.ctx.fill();

                        // Draw value label on the bar segment if it's large enough
                        if (this.animationProgress >= 1 && value > 0 && barHeight > 15) {
                            this.ctx.fillStyle = '#fff';
                            this.ctx.font = 'bold 12px Arial';
                            this.ctx.textAlign = 'center';
                            this.ctx.textBaseline = 'middle';
                            this.ctx.fillText(value.toString(), x + barGroupWidth / 2, barY + barHeight / 2);
                        }

                        // Add to stacked height for next segment
                        stackedHeight += barHeight;
                        totalValue += value;
                    }
                });

                // Draw total value on top of the stacked bar
                if (this.animationProgress >= 1 && totalValue > 0) {
                    const totalY = this.chartArea.y + this.chartArea.height - 60 - stackedHeight;
                    this.ctx.fillStyle = '#374151';
                    this.ctx.font = 'bold 13px Arial';
                    this.ctx.textAlign = 'center';
                    this.ctx.textBaseline = 'bottom';
                    this.ctx.fillText('Total: ' + totalValue, x + barGroupWidth / 2, totalY - 5);
                }
            } else {
                // Draw grouped bars
                const barWidth = barGroupWidth / datasets.length;

                datasets.forEach((dataset, datasetIndex) => {
                    const value = dataset.data[labelIndex] || 0;
                    const animatedValue = value * this.animationProgress;
                    const barHeight = (animatedValue / maxValue) * (this.chartArea.height - 80);
                    const barX = x + datasetIndex * barWidth;
                    const barY = this.chartArea.y + this.chartArea.height - barHeight - 60;

                    // Draw bar
                    this.ctx.fillStyle = dataset.backgroundColor as string || '#3b82f6';
                    this.roundRect(barX, barY, barWidth * 0.9, barHeight, 2);
                    this.ctx.fill();

                    // Draw value on top
                    if (this.animationProgress >= 1 && value > 0) {
                        this.ctx.fillStyle = '#666';
                        this.ctx.font = 'bold 11px Arial';
                        this.ctx.textAlign = 'center';
                        this.ctx.fillText(value.toString(), barX + barWidth / 2, barY - 5);
                    }
                });
            }
        }

        // Draw x-axis labels
        for (let labelIndex = 0; labelIndex < barCount; labelIndex++) {
            const x = this.chartArea.x + labelIndex * totalBarWidth + totalBarWidth / 2;

            this.ctx.save();
            this.ctx.fillStyle = '#666';
            this.ctx.font = '11px Arial';

            const label = this.data.labels[labelIndex];
            const truncatedLabel = label.length > 20 ? label.substring(0, 20) + '...' : label;

            // Position labels below the chart with proper spacing
            this.ctx.translate(x, this.chartArea.y + this.chartArea.height + 10);

            // Check for rotation - ensure labels are always drawn
            if (this.options.scales?.x?.ticks?.maxRotation) {
                this.ctx.rotate(-Math.PI * this.options.scales.x.ticks.maxRotation / 180);
                this.ctx.textAlign = 'right';
                this.ctx.textBaseline = 'middle';
                // Draw full label for timeline chart without truncation to show scenario names
                this.ctx.fillText(label, 0, 0);
            } else {
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'top';
                this.ctx.fillText(truncatedLabel, 0, 0);
            }

            this.ctx.restore();
        }
    }

    private renderLineChart(): void {
        const datasets = this.data.datasets;
        const pointCount = this.data.labels.length;
        const pointSpacing = pointCount > 1 ? this.chartArea.width / (pointCount - 1) : this.chartArea.width;

        // Find max values for each y-axis
        const maxValues: Record<string, number> = {};
        datasets.forEach(dataset => {
            const yAxisId = dataset.yAxisID || 'y';
            const maxVal = Math.max(...dataset.data);
            maxValues[yAxisId] = Math.max(maxValues[yAxisId] || 0, maxVal);
        });

        // Draw grid for primary axis
        this.drawGrid(maxValues['y'] || 100);

        // Draw secondary y-axis if needed
        const hasSecondaryAxis = Object.keys(maxValues).length > 1;
        if (hasSecondaryAxis && maxValues['y1']) {
            this.drawSecondaryYAxis(maxValues['y1']);
        }

        // Draw each dataset
        datasets.forEach((dataset, datasetIndex) => {
            const yAxisId = dataset.yAxisID || 'y';
            const maxValue = maxValues[yAxisId] || 100; // Prevent division by zero

            // Calculate points
            const points: Array<{x: number, y: number, originalY: number}> = [];
            dataset.data.forEach((value, index) => {
                const animatedValue = value * this.animationProgress;
                const x = this.chartArea.x + index * pointSpacing;
                const y = this.chartArea.y + this.chartArea.height - 60 - (animatedValue / maxValue) * (this.chartArea.height - 80);
                points.push({
                    x,
                    y,
                    originalY: this.chartArea.y + this.chartArea.height - 60 - (value / maxValue) * (this.chartArea.height - 80)
                });
            });

            // Draw line
            this.ctx.beginPath();
            this.ctx.strokeStyle = dataset.borderColor as string || '#3b82f6';
            this.ctx.lineWidth = dataset.borderWidth || 2;

            points.forEach((point, index) => {
                if (index === 0) {
                    this.ctx.moveTo(point.x, point.y);
                } else {
                    // Apply tension for smooth curves
                    if (dataset.tension && dataset.tension > 0 && index > 0) {
                        const cp1x = points[index - 1].x + pointSpacing * dataset.tension;
                        const cp1y = points[index - 1].y;
                        const cp2x = point.x - pointSpacing * dataset.tension;
                        const cp2y = point.y;
                        this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, point.x, point.y);
                    } else {
                        this.ctx.lineTo(point.x, point.y);
                    }
                }
            });

            this.ctx.stroke();

            // Fill area under line if specified
            if (dataset.fill) {
                this.ctx.lineTo(points[points.length - 1].x, this.chartArea.y + this.chartArea.height - 40);
                this.ctx.lineTo(points[0].x, this.chartArea.y + this.chartArea.height - 40);
                this.ctx.closePath();
                this.ctx.fillStyle = dataset.backgroundColor as string || 'rgba(59, 130, 246, 0.1)';
                this.ctx.fill();
            }

            // Draw points (only after animation)
            if (this.animationProgress >= 1) {
                points.forEach((point, index) => {
                    this.ctx.beginPath();
                    this.ctx.arc(point.x, point.originalY, 4, 0, Math.PI * 2);
                    this.ctx.fillStyle = dataset.borderColor as string || '#3b82f6';
                    this.ctx.fill();
                    this.ctx.strokeStyle = '#fff';
                    this.ctx.lineWidth = 2;
                    this.ctx.stroke();
                });
            }
        }); // End datasets.forEach

        // Draw labels with rotation to prevent overlap
        this.data.labels.forEach((label, index) => {
            const x = this.chartArea.x + index * pointSpacing;
            this.ctx.fillStyle = '#666';
            this.ctx.font = '10px Arial';

            // Skip some labels if there are too many
            if (this.data.labels.length > 10 && index % 2 !== 0) {
                return;
            }

            // Rotate labels if there are more than 5
            if (this.data.labels.length > 5) {
                this.ctx.save();
                this.ctx.translate(x, this.chartArea.y + this.chartArea.height + 5);
                this.ctx.rotate(-Math.PI / 6);
                this.ctx.textAlign = 'right';
                const truncatedLabel = label.length > 12 ? label.substring(0, 12) + '...' : label;
                this.ctx.fillText(truncatedLabel, 0, 0);
                this.ctx.restore();
            } else {
                this.ctx.textAlign = 'center';
                const truncatedLabel = label.length > 15 ? label.substring(0, 15) + '...' : label;
                this.ctx.fillText(truncatedLabel, x, this.chartArea.y + this.chartArea.height + 15);
            }
        });
    }

    private roundRect(x: number, y: number, width: number, height: number, radius: number): void {
        this.ctx.beginPath();
        this.ctx.moveTo(x + radius, y);
        this.ctx.lineTo(x + width - radius, y);
        this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        this.ctx.lineTo(x + width, y + height);
        this.ctx.lineTo(x, y + height);
        this.ctx.lineTo(x, y + radius);
        this.ctx.quadraticCurveTo(x, y, x + radius, y);
        this.ctx.closePath();
    }

    private drawSecondaryYAxis(maxValue: number): void {
        // Draw secondary y-axis on the right
        const x = this.chartArea.x + this.chartArea.width;

        this.ctx.strokeStyle = '#9ca3af';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(x, this.chartArea.y);
        this.ctx.lineTo(x, this.chartArea.y + this.chartArea.height - 60);
        this.ctx.stroke();

        // Draw scale labels
        const steps = 5;
        for (let i = 0; i <= steps; i++) {
            const y = this.chartArea.y + (i / steps) * (this.chartArea.height - 60);
            const value = Math.round(maxValue * (1 - i / steps));

            this.ctx.fillStyle = '#666';
            this.ctx.font = '10px Arial';
            this.ctx.textAlign = 'left';
            this.ctx.fillText(value.toString(), x + 5, y + 3);
        }
    }

    private drawGrid(maxValue: number): void {
        const gridLines = 5;

        for (let i = 0; i <= gridLines; i++) {
            const y = this.chartArea.y + (this.chartArea.height - 40) * (1 - i / gridLines);

            // Draw grid line
            this.ctx.beginPath();
            this.ctx.moveTo(this.chartArea.x, y);
            this.ctx.lineTo(this.chartArea.x + this.chartArea.width, y);
            this.ctx.strokeStyle = '#e5e7eb';
            this.ctx.lineWidth = 1;

            // Dashed lines
            this.ctx.setLineDash([5, 5]);
            this.ctx.stroke();
            this.ctx.setLineDash([]);

            // Draw y-axis label
            const value = Math.round((maxValue * i) / gridLines);
            this.ctx.fillStyle = '#666';
            this.ctx.font = '11px Arial';
            this.ctx.textAlign = 'right';
            this.ctx.fillText(value.toString(), this.chartArea.x - 10, y + 3);
        }

        // Draw axes
        this.ctx.beginPath();
        this.ctx.moveTo(this.chartArea.x, this.chartArea.y);
        this.ctx.lineTo(this.chartArea.x, this.chartArea.y + this.chartArea.height - 40);
        this.ctx.lineTo(this.chartArea.x + this.chartArea.width, this.chartArea.y + this.chartArea.height - 40);
        this.ctx.strokeStyle = '#9ca3af';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();
    }

    private renderLegend(): void {
        // For bar/line charts, show dataset labels. For pie/doughnut, show data labels
        let items: string[];
        let colors: (string | string[])[];
        if (this.type === 'bar' || this.type === 'line') {
            items = this.data.datasets.map(ds => ds.label || 'Dataset');
            colors = this.data.datasets.map(ds => ds.backgroundColor || ds.borderColor || '#000');
        } else {
            items = this.data.labels;
            const dataset = this.data.datasets[0];
            colors = Array.isArray(dataset.backgroundColor)
                ? dataset.backgroundColor
                : new Array(items.length).fill(dataset.backgroundColor || '#000');
        }
        const legendPosition = this.options.plugins?.legend?.position || 'bottom';

        if (legendPosition === 'right') {
            // Vertical legend on the right
            const itemHeight = 25;
            const startY = this.legendArea.y + 20;

            items.forEach((label, index) => {
                const x = this.legendArea.x + 10;
                const y = startY + index * itemHeight;

                // Skip if outside bounds
                if (y + itemHeight > this.legendArea.y + this.legendArea.height) return;

                // Draw color indicator
                this.ctx.fillStyle = Array.isArray(colors[index]) ? colors[index][0] as string : colors[index] as string || '#000';

                if (this.type === 'doughnut' || this.type === 'pie') {
                    this.ctx.beginPath();
                    this.ctx.arc(x + 8, y + 8, 6, 0, Math.PI * 2);
                    this.ctx.fill();
                } else {
                    this.ctx.fillRect(x, y + 3, 12, 12);
                }

                // Draw label
                this.ctx.fillStyle = '#666';
                this.ctx.font = '11px Arial';
                this.ctx.textAlign = 'left';

                // Measure text and adjust if needed
                const fullLabel = label;
                const metrics = this.ctx.measureText(fullLabel);
                const maxLabelWidth = this.legendArea.width - 30;

                if (metrics.width <= maxLabelWidth) {
                    this.ctx.fillText(fullLabel, x + 20, y + 12);
                } else {
                    // Wrap text if too long
                    const words = fullLabel.split(' ');
                    let line = '';
                    let lineY = y + 12;

                    for (let n = 0; n < words.length; n++) {
                        const testLine = line + words[n] + ' ';
                        const testMetrics = this.ctx.measureText(testLine);
                        if (testMetrics.width > maxLabelWidth && n > 0) {
                            this.ctx.fillText(line.trim(), x + 20, lineY);
                            line = words[n] + ' ';
                            lineY += 12;
                        } else {
                            line = testLine;
                        }
                    }
                    this.ctx.fillText(line.trim(), x + 20, lineY);
                }
            });
        } else {
            // Horizontal legend at the bottom
            const itemsPerRow = Math.min(items.length, 5);
            const rows = Math.ceil(items.length / itemsPerRow);
            const itemWidth = this.legendArea.width / itemsPerRow;
            const rowHeight = 25;

            items.forEach((label, index) => {
                const row = Math.floor(index / itemsPerRow);
                const col = index % itemsPerRow;
                const x = this.legendArea.x + col * itemWidth;
                const y = this.legendArea.y + row * rowHeight + 10;

                // Draw color box
                this.ctx.fillStyle = Array.isArray(colors[index]) ? colors[index][0] as string : colors[index] as string || '#000';

                // Use circle for pie/doughnut, square for others
                if (this.type === 'doughnut' || this.type === 'pie') {
                    this.ctx.beginPath();
                    this.ctx.arc(x + 8, y + 8, 6, 0, Math.PI * 2);
                    this.ctx.fill();
                } else {
                    this.ctx.fillRect(x, y, 15, 15);
                }

                // Draw label
                this.ctx.fillStyle = '#666';
                this.ctx.font = '12px Arial';
                this.ctx.textAlign = 'left';
                const truncatedLabel = label.length > 15 ? label.substring(0, 15) + '...' : label;
                this.ctx.fillText(truncatedLabel, x + 20, y + 12);
            });
        }
    }

    private truncateText(text: string, maxWidth: number): string {
        const metrics = this.ctx.measureText(text);
        if (metrics.width <= maxWidth) return text;

        let truncated = text;
        while (this.ctx.measureText(truncated + '...').width > maxWidth && truncated.length > 0) {
            truncated = truncated.substring(0, truncated.length - 1);
        }
        return truncated + '...';
    }

    private handleMouseMove(x: number, y: number): void {
        const previousHovered = this.hoveredSegment;
        this.hoveredSegment = this.getSegmentAtPosition(x, y);

        if (previousHovered !== this.hoveredSegment) {
            this.render();

            if (this.hoveredSegment >= 0) {
                this.showTooltip(x, y, this.hoveredSegment);
            } else {
                this.hideTooltip();
            }
        }
    }

    private getSegmentAtPosition(x: number, y: number): number {
        if (this.type === 'doughnut' || this.type === 'pie') {
            const centerX = this.chartArea.x + this.chartArea.width / 2;
            const centerY = this.chartArea.y + this.chartArea.height / 2;
            const dx = x - centerX;
            const dy = y - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const radius = Math.min(this.chartArea.width, this.chartArea.height) / 2 - 20;
            const innerRadius = this.type === 'doughnut' ? radius * 0.5 : 0;

            if (distance >= innerRadius && distance <= radius) {
                const angle = Math.atan2(dy, dx) + Math.PI / 2;
                const normalizedAngle = angle < 0 ? angle + Math.PI * 2 : angle;

                const dataset = this.data.datasets[0];
                const total = dataset.data.reduce((a, b) => a + b, 0);
                let currentAngle = 0;

                for (let i = 0; i < dataset.data.length; i++) {
                    const sliceAngle = (dataset.data[i] / total) * Math.PI * 2;
                    if (normalizedAngle >= currentAngle && normalizedAngle < currentAngle + sliceAngle) {
                        return i;
                    }
                    currentAngle += sliceAngle;
                }
            }
        } else if (this.type === 'bar') {
            const barCount = this.data.labels.length;
            const barWidth = (this.chartArea.width / barCount) * 0.7;
            const barSpacing = (this.chartArea.width / barCount) * 0.3;

            for (let i = 0; i < barCount; i++) {
                const barX = this.chartArea.x + i * (barWidth + barSpacing) + barSpacing / 2;
                if (x >= barX && x <= barX + barWidth && y >= this.chartArea.y && y <= this.chartArea.y + this.chartArea.height - 40) {
                    return i;
                }
            }
        } else if (this.type === 'line') {
            const pointSpacing = this.chartArea.width / (this.data.labels.length - 1);

            for (let i = 0; i < this.data.labels.length; i++) {
                const pointX = this.chartArea.x + i * pointSpacing;
                if (Math.abs(x - pointX) < 15) {
                    return i;
                }
            }
        }

        return -1;
    }

    private showTooltip(x: number, y: number, index: number): void {
        if (!this.tooltipElement) {
            this.tooltipElement = document.createElement('div');
            this.tooltipElement.style.position = 'fixed';
            this.tooltipElement.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
            this.tooltipElement.style.color = 'white';
            this.tooltipElement.style.padding = '8px 12px';
            this.tooltipElement.style.borderRadius = '6px';
            this.tooltipElement.style.fontSize = '13px';
            this.tooltipElement.style.pointerEvents = 'none';
            this.tooltipElement.style.zIndex = '10000';
            this.tooltipElement.style.fontFamily = 'Arial, sans-serif';
            this.tooltipElement.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
            document.body.appendChild(this.tooltipElement);
        }

        const dataset = this.data.datasets[0];
        const label = this.data.labels[index];
        const value = dataset.data[index];

        let tooltipText = `${label}: ${value}`;

        if (this.type === 'doughnut' || this.type === 'pie') {
            const total = dataset.data.reduce((a, b) => a + b, 0);
            const percentage = ((value / total) * 100).toFixed(1);
            tooltipText = `${label}: ${value} (${percentage}%)`;
        }

        if (this.options.plugins?.tooltip?.callbacks?.label) {
            tooltipText = this.options.plugins.tooltip.callbacks.label({
                label: label,
                parsed: value,
                dataset: dataset,
                datasetIndex: 0,
                dataIndex: index
            });
        }

        this.tooltipElement.innerHTML = tooltipText;

        const rect = this.canvas.getBoundingClientRect();
        const tooltipRect = this.tooltipElement.getBoundingClientRect();

        let left = rect.left + x + 10;
        let top = rect.top + y - 30;

        // Adjust if tooltip goes off screen
        if (left + tooltipRect.width > window.innerWidth) {
            left = rect.left + x - tooltipRect.width - 10;
        }
        if (top < 0) {
            top = rect.top + y + 10;
        }

        this.tooltipElement.style.left = `${left}px`;
        this.tooltipElement.style.top = `${top}px`;
        this.tooltipElement.style.display = 'block';
    }

    private hideTooltip(): void {
        if (this.tooltipElement) {
            this.tooltipElement.style.display = 'none';
        }
    }

    public update(data: ChartData): void {
        this.data = data;
        this.startAnimation();
    }

    public destroy(): void {
        if (this.tooltipElement && this.tooltipElement.parentNode) {
            this.tooltipElement.parentNode.removeChild(this.tooltipElement);
        }

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Remove event listeners would require storing references
        // For now, we'll leave them (they'll be cleaned up when element is removed)
    }
}

// Make it globally available
if (typeof window !== 'undefined') {
    window.CSChart = CSChart;
}

// Export for TypeScript modules
export { CSChart };
export type { ChartConfig, ChartData, ChartDataset, ChartOptions };
