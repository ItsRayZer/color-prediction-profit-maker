import React, { useState } from 'react';
import { 
  MousePointer, 
  Slash, 
  Minus, 
  Divide, 
  TrendingUp, 
  Grid, 
  Square, 
  Circle as CircleIcon, 
  Triangle as TriangleIcon, 
  Type, 
  MessageSquare, 
  ArrowUpRight, 
  Ruler, 
  Target, 
  Trash2, 
  RotateCcw, 
  RotateCw, 
  Download, 
  Upload, 
  Palette, 
  PenTool, 
  Sliders,
  ChevronRight,
  ChevronDown
} from 'lucide-react';
import { useChartStore } from '../../store/useChartStore';

interface DrawingToolbarProps {
  onUndo?: () => void;
  onRedo?: () => void;
  onClearAll?: () => void;
  onDeleteSelected?: () => void;
  onExportJson?: () => void;
  onImportJson?: () => void;
}

interface ToolGroup {
  id: string;
  name: string;
  icon: React.ReactNode;
  tools: { id: string; name: string; icon?: React.ReactNode }[];
}

export const DrawingToolbar: React.FC<DrawingToolbarProps> = ({
  onUndo,
  onRedo,
  onClearAll,
  onDeleteSelected,
  onExportJson,
  onImportJson
}) => {
  const { 
    activeDrawingTool, 
    setActiveDrawingTool, 
    drawingColor, 
    setDrawingColor, 
    drawingLineWidth, 
    setDrawingLineWidth 
  } = useChartStore();

  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const toolGroups: ToolGroup[] = [
    {
      id: 'lines',
      name: 'Trend Lines',
      icon: <Slash size={16} className="rotate-45" />,
      tools: [
        { id: 'trend-line', name: 'Trend Line' },
        { id: 'ray', name: 'Ray' },
        { id: 'info-line', name: 'Info Line' },
        { id: 'extended-line', name: 'Extended Line' },
        { id: 'trend-angle', name: 'Trend Angle' },
        { id: 'horizontal-line', name: 'Horizontal Line' },
        { id: 'horizontal-ray', name: 'Horizontal Ray' },
        { id: 'vertical-line', name: 'Vertical Line' },
        { id: 'cross-line', name: 'Cross Line' }
      ]
    },
    {
      id: 'channels',
      name: 'Channels & Pitchforks',
      icon: <Divide size={16} />,
      tools: [
        { id: 'parallel-channel', name: 'Parallel Channel' },
        { id: 'regression-trend', name: 'Regression Trend' },
        { id: 'disjoint-channel', name: 'Disjoint Channel' },
        { id: 'flat-top-bottom', name: 'Flat Top/Bottom' },
        { id: 'andrews-pitchfork', name: "Andrews' Pitchfork" },
        { id: 'schiff-pitchfork', name: 'Schiff Pitchfork' },
        { id: 'modified-schiff-pitchfork', name: 'Modified Schiff' },
        { id: 'inside-pitchfork', name: 'Inside Pitchfork' },
        { id: 'pitchfan', name: 'Pitchfan' }
      ]
    },
    {
      id: 'fibonacci',
      name: 'Fibonacci & Gann',
      icon: <Grid size={16} />,
      tools: [
        { id: 'fib-retracement', name: 'Fib Retracement' },
        { id: 'fib-extension', name: 'Trend-Based Fib Extension' },
        { id: 'fib-channel', name: 'Fib Channel' },
        { id: 'fib-time-zone', name: 'Fib Time Zone' },
        { id: 'fib-circles', name: 'Fib Circles' },
        { id: 'fib-spiral', name: 'Fib Spiral' },
        { id: 'fib-speed-fan', name: 'Fib Speed Resistance Fan' },
        { id: 'gann-box', name: 'Gann Box' },
        { id: 'gann-fan', name: 'Gann Fan' },
        { id: 'gann-square', name: 'Gann Square' }
      ]
    },
    {
      id: 'shapes',
      name: 'Geometric Shapes',
      icon: <Square size={16} />,
      tools: [
        { id: 'rectangle', name: 'Rectangle' },
        { id: 'rotated-rectangle', name: 'Rotated Rectangle' },
        { id: 'circle', name: 'Circle' },
        { id: 'ellipse', name: 'Ellipse' },
        { id: 'triangle', name: 'Triangle' },
        { id: 'polyline', name: 'Polyline' },
        { id: 'curve', name: 'Curve (Bezier)' },
        { id: 'double-curve', name: 'Double Curve' },
        { id: 'arc', name: 'Arc' }
      ]
    },
    {
      id: 'freehand',
      name: 'Brushes & Markers',
      icon: <PenTool size={16} />,
      tools: [
        { id: 'brush', name: 'Brush' },
        { id: 'highlighter', name: 'Highlighter' },
        { id: 'arrow', name: 'Arrow' },
        { id: 'arrow-marker', name: 'Arrow Marker' },
        { id: 'arrow-mark-up', name: 'Arrow Up (Bullish)' },
        { id: 'arrow-mark-down', name: 'Arrow Down (Bearish)' }
      ]
    },
    {
      id: 'annotations',
      name: 'Annotations & Text',
      icon: <Type size={16} />,
      tools: [
        { id: 'text-annotation', name: 'Text' },
        { id: 'anchored-text', name: 'Anchored Text' },
        { id: 'note', name: 'Note' },
        { id: 'pin', name: 'Pin' },
        { id: 'callout', name: 'Callout' },
        { id: 'comment', name: 'Comment' },
        { id: 'price-label', name: 'Price Label' },
        { id: 'price-note', name: 'Price Note' },
        { id: 'signpost', name: 'Signpost' }
      ]
    },
    {
      id: 'measurement',
      name: 'Measurement & Forecast',
      icon: <Ruler size={16} />,
      tools: [
        { id: 'long-position', name: 'Long Position' },
        { id: 'short-position', name: 'Short Position' },
        { id: 'forecast', name: 'Forecast Tool' },
        { id: 'date-price-range', name: 'Date and Price Range' },
        { id: 'price-range', name: 'Price Range' },
        { id: 'date-range', name: 'Date Range' },
        { id: 'bars-pattern', name: 'Bars Pattern' }
      ]
    }
  ];

  const handleSelectTool = (toolId: string | null) => {
    setActiveDrawingTool(toolId);
    setOpenGroup(null);
  };

  return (
    <div className="relative z-20 flex">
      {/* Floating Vertical Toolbar */}
      <aside className="w-11 bg-[#1e222d] border-r border-[#2a2e39] flex flex-col items-center py-2 space-y-1 text-[#787b86]">
        {/* Cursor / Select */}
        <button
          onClick={() => handleSelectTool(null)}
          title="Cursor / Select"
          className={`p-2 rounded hover:bg-[#2a2e39] hover:text-white transition-colors relative ${
            activeDrawingTool === null ? 'bg-[#2962ff] text-white shadow-sm' : ''
          }`}
        >
          <MousePointer size={16} />
        </button>

        <div className="w-6 h-[1px] bg-[#2a2e39] my-1" />

        {/* Tool Category Buttons */}
        {toolGroups.map(group => {
          const isGroupActive = group.tools.some(t => t.id === activeDrawingTool);
          const isOpen = openGroup === group.id;

          return (
            <div key={group.id} className="relative">
              <button
                onClick={() => setOpenGroup(isOpen ? null : group.id)}
                title={group.name}
                className={`p-2 rounded hover:bg-[#2a2e39] hover:text-white transition-colors relative group flex items-center ${
                  isGroupActive ? 'bg-[#2a2e39] text-[#2962ff] font-bold border border-[#2962ff]/40' : ''
                }`}
              >
                {group.icon}
                <span className="absolute bottom-0.5 right-0.5 w-1 h-1 bg-[#787b86] rounded-full group-hover:bg-[#2962ff]"></span>
              </button>

              {/* Flyout Submenu */}
              {isOpen && (
                <div className="absolute left-12 top-0 bg-[#1e222d] border border-[#2a2e39] rounded shadow-2xl py-1 w-52 z-50 text-xs max-h-72 overflow-y-auto">
                  <div className="px-3 py-1 font-semibold text-[#787b86] border-b border-[#2a2e39] uppercase text-[10px] tracking-wider">
                    {group.name}
                  </div>
                  {group.tools.map(tool => (
                    <button
                      key={tool.id}
                      onClick={() => handleSelectTool(tool.id)}
                      className={`w-full text-left px-3 py-1.5 hover:bg-[#2a2e39] flex items-center justify-between transition-colors ${
                        activeDrawingTool === tool.id ? 'text-[#2962ff] font-bold bg-[#2a2e39]/50' : 'text-[#d1d4dc]'
                      }`}
                    >
                      <span>{tool.name}</span>
                      {activeDrawingTool === tool.id && <span className="w-1.5 h-1.5 bg-[#2962ff] rounded-full"></span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="w-6 h-[1px] bg-[#2a2e39] my-1" />

        {/* Color Picker Quick Toggle */}
        <div className="relative group p-1.5">
          <input
            type="color"
            value={drawingColor}
            onChange={(e) => setDrawingColor(e.target.value)}
            title="Drawing Color"
            className="w-5 h-5 rounded-full border border-[#2a2e39] bg-transparent cursor-pointer"
          />
        </div>

        {/* Line Width Quick Button */}
        <button
          onClick={() => setDrawingLineWidth(drawingLineWidth === 4 ? 1 : drawingLineWidth + 1)}
          title={`Line Width: ${drawingLineWidth}px`}
          className="p-1.5 rounded hover:bg-[#2a2e39] hover:text-white text-[10px] font-bold"
        >
          {drawingLineWidth}px
        </button>

        <div className="w-6 h-[1px] bg-[#2a2e39] my-1" />

        {/* Undo / Redo */}
        {onUndo && (
          <button
            onClick={onUndo}
            title="Undo Drawing"
            className="p-2 rounded hover:bg-[#2a2e39] hover:text-white transition-colors"
          >
            <RotateCcw size={15} />
          </button>
        )}
        {onRedo && (
          <button
            onClick={onRedo}
            title="Redo Drawing"
            className="p-2 rounded hover:bg-[#2a2e39] hover:text-white transition-colors"
          >
            <RotateCw size={15} />
          </button>
        )}

        {/* Delete Selected */}
        {onDeleteSelected && (
          <button
            onClick={onDeleteSelected}
            title="Delete Selected Drawing"
            className="p-2 rounded hover:bg-[#2a2e39] hover:text-[#ef5350] transition-colors"
          >
            <Trash2 size={15} />
          </button>
        )}

        {/* Clear All */}
        {onClearAll && (
          <button
            onClick={onClearAll}
            title="Clear All Drawings"
            className="p-2 rounded hover:bg-[#2a2e39] hover:text-[#ef5350] text-[10px] font-semibold"
          >
            CLR
          </button>
        )}

        {/* Export / Import JSON */}
        <div className="mt-auto pb-2 flex flex-col space-y-1">
          {onExportJson && (
            <button
              onClick={onExportJson}
              title="Export Drawings JSON"
              className="p-2 rounded hover:bg-[#2a2e39] hover:text-white transition-colors"
            >
              <Download size={14} />
            </button>
          )}
          {onImportJson && (
            <button
              onClick={onImportJson}
              title="Import Drawings JSON"
              className="p-2 rounded hover:bg-[#2a2e39] hover:text-white transition-colors"
            >
              <Upload size={14} />
            </button>
          )}
        </div>
      </aside>
    </div>
  );
};
