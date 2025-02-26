import webview
import os
import threading
import time
import subprocess
import platform
import json
import sys
import traceback
import logging
import socket
from datetime import datetime
from typing import List, Dict
import re

# Set up logging
log_dir = os.path.join(os.path.expanduser("~"), "NetworkMonitor_Logs")
os.makedirs(log_dir, exist_ok=True)
log_file = os.path.join(log_dir, f"network_monitor_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger("NetworkMonitor")

# Global exception handler
def global_exception_handler(exctype, value, tb):
    logger.error("Uncaught exception:", exc_info=(exctype, value, tb))
    # Also write to a specific error file that's easy to find
    with open(os.path.join(log_dir, "CRITICAL_ERROR.txt"), "a") as f:
        f.write(f"\n\n--- {datetime.now()} ---\n")
        f.write("".join(traceback.format_exception(exctype, value, tb)))
    sys.__excepthook__(exctype, value, tb)

# Install the global exception handler
sys.excepthook = global_exception_handler

# Log startup info
logger.info(f"Application starting up, Python version: {sys.version}")
logger.info(f"Platform: {platform.platform()}")

# Flag to determine if running as executable
is_frozen = getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')

# Use a lock file approach instead of mutex for the executable
lock_file_path = os.path.join(os.path.expanduser("~"), ".network_monitor.lock")

# IMPORTANT: Global thread reference to prevent garbage collection
_update_thread = None

# Helper function to get the correct base path depending on how the app is run
def get_base_path():
    """Get the base path for resources, handling both development and PyInstaller frozen contexts"""
    if is_frozen:
        # Running as a PyInstaller bundle
        base_path = sys._MEIPASS
        logger.info(f"Running in PyInstaller bundle mode, MEIPASS: {base_path}")
    else:
        # Running in normal Python environment
        base_path = os.path.dirname(os.path.abspath(__file__))
        logger.info(f"Running in development mode, base path: {base_path}")
    
    return base_path

def check_single_instance():
    """
    Simple lock file approach for single instance
    """
    try:
        if os.path.exists(lock_file_path):
            # Check if the process with the pid in the lock file is still running
            try:
                with open(lock_file_path, 'r') as f:
                    pid = int(f.read().strip())
                
                # Check if the process is still running
                if is_process_running(pid):
                    logger.warning(f"Another instance (PID {pid}) is already running.")
                    # Only show message box if we're not being called repeatedly
                    if is_frozen:
                        try:
                            import ctypes
                            ctypes.windll.user32.MessageBoxW(0, 
                                "Another instance of Network Monitor is already running.", 
                                "Network Monitor", 0)
                        except Exception as e:
                            logger.error(f"Failed to show MessageBox: {e}")
                    return False
            except (ValueError, FileNotFoundError):
                # Invalid or missing PID, clean up the lock file
                logger.info("Found invalid or stale lock file, removing it.")
                remove_lock_file()
        
        # No valid lock file exists, create one with our PID
        with open(lock_file_path, 'w') as f:
            f.write(str(os.getpid()))
        
        logger.info(f"Created lock file with PID {os.getpid()}")
        return True
        
    except Exception as e:
        logger.error(f"Error in check_single_instance: {str(e)}")
        # If there's an error, allow the application to run
        return True

def is_process_running(pid):
    """Check if a process with given PID is running"""
    if platform.system().lower() == "windows":
        try:
            # Windows-specific way to check process
            import ctypes
            kernel32 = ctypes.windll.kernel32
            SYNCHRONIZE = 0x00100000
            process = kernel32.OpenProcess(SYNCHRONIZE, 0, pid)
            if process != 0:
                kernel32.CloseHandle(process)
                return True
            return False
        except:
            # Fallback if the above fails
            try:
                # Alternative method using tasklist
                output = subprocess.check_output(f'tasklist /FI "PID eq {pid}" /NH', shell=True)
                return str(pid) in str(output)
            except:
                return False
    else:
        # Unix-like systems
        try:
            os.kill(pid, 0)  # This doesn't kill the process, just checks if it exists
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # Process exists but we don't have permission to send signals to it
            return True

def remove_lock_file():
    """Remove the lock file if it exists"""
    try:
        if os.path.exists(lock_file_path):
            os.remove(lock_file_path)
            logger.info(f"Removed lock file: {lock_file_path}")
    except Exception as e:
        logger.error(f"Error removing lock file: {str(e)}")

class API:
    def __init__(self, window):
        self.window = window
        # Default to 500 milliseconds for testing, can be adjusted via UI
        self.current_interval = 500 
        self.update_thread = None
        self.should_run = False  # Start as False until explicitly started
        self.js_is_ready = False
        self.TARGET_HOST = "8.8.8.8"  # Google DNS server
        self._exit_flag = threading.Event()
        self._thread_started = False
        self._last_ping_data = None  # Cache for the most recent ping data
        self._ping_lock = threading.Lock()  # Add a lock to prevent concurrent pings
        self._ping_history = []  # Store recent ping times for jitter calculation
        self._max_history = 5  # Keep last 5 pings for calculations

    def get_ping_data(self):
        """Get ping metrics and return as JSON string"""
        # Return cached data instead of triggering a new ping
        if self._last_ping_data:
            return json.dumps(self._last_ping_data)
        else:
            # Only if we don't have data yet, do a ping
            return json.dumps(self.ping_host())
    
    def set_interval(self, new_interval):
        """Update the ping interval"""
        logger.info(f"Received new interval: {new_interval}ms")
        self.current_interval = new_interval
        logger.info(f"Updated interval to: {self.current_interval}ms")
        return json.dumps({"success": True})
    
    def ping_host(self) -> Dict[str, float]:
        """Ping the target host using optimized socket method"""
        with self._ping_lock:
            logger.debug(f"Using socket ping to {self.TARGET_HOST}")
            logger.debug(f"PING REQUEST from {traceback.extract_stack()[-2][2]} at {datetime.now().strftime('%H:%M:%S.%f')}")
            result = self.optimized_socket_ping()
            # Cache the result
            self._last_ping_data = result
            return result
    
    def optimized_socket_ping(self) -> Dict[str, float]:
        """
        Improved socket ping with better accuracy
        """
        times = []
        losses = 0
        
        try:
            # Try a faster approach with a fixed port
            # Port 443 (HTTPS) is commonly open
            port = 443
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1.0)  # 1 second timeout
            
            # Time just the connection
            start_time = time.time()
            try:
                s.connect((self.TARGET_HOST, port))
                end_time = time.time()
                s.close()
                # Calculate round trip time in ms
                rtt = (end_time - start_time) * 1000
                times.append(rtt)
            except:
                # If first attempt fails, try alternative ports
                s.close()  # Close the failed socket
                
                # Try alternative common ports
                alternate_ports = [80, 53]
                for alt_port in alternate_ports:
                    try:
                        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        s.settimeout(1.0)
                        start_time = time.time()
                        s.connect((self.TARGET_HOST, alt_port))
                        end_time = time.time()
                        s.close()
                        rtt = (end_time - start_time) * 1000
                        times.append(rtt)
                        break
                    except:
                        s.close()
                
                if not times:
                    losses += 1
            
        except Exception as e:
            logger.error(f"Socket ping error: {str(e)}")
            losses += 1
        
        # Calculate metrics
        if times:
            latency = times[0]
            
            # Add to history for jitter calculation
            self._ping_history.append(latency)
            # Keep history at max size
            if len(self._ping_history) > self._max_history:
                self._ping_history.pop(0)
            
            # Calculate jitter if we have enough history
            jitter = 0
            if len(self._ping_history) >= 2:
                # Calculate variation between consecutive samples
                variations = [abs(self._ping_history[i] - self._ping_history[i-1]) 
                             for i in range(1, len(self._ping_history))]
                jitter = sum(variations) / len(variations)
            
            packet_loss = 0
        else:
            latency = 0
            jitter = 0
            packet_loss = 100
            # Add a failed ping to history
            self._ping_history.append(0)
            if len(self._ping_history) > self._max_history:
                self._ping_history.pop(0)
        
        # Apply calibration based on typical difference between socket and ICMP ping
        # Typical socket ping is ~15ms higher than ICMP ping for same target
        calibration_factor = 0.7  # Empirical factor to get closer to ICMP ping values
        calibrated_latency = latency * calibration_factor if latency > 0 else 0
        
        return {
            'latency': round(calibrated_latency, 1),
            'jitter': round(jitter, 1),
            'packetLoss': round(packet_loss, 1)
        }

    def js_ready(self):
        """Signal that JavaScript is ready"""
        logger.info("JavaScript is ready!")
        self.js_is_ready = True
        
        # Start update thread if not already running
        if not self._thread_started:
            self.start_update_thread()
        
        # Send an initial empty metrics to kickstart the UI without causing a ping
        try:
            if self.window:
                js_command = f'if(typeof window.updateMetrics === "function") {{ window.updateMetrics({json.dumps({"latency": 0, "jitter": 0, "packetLoss": 0})}); }}'
                self.window.evaluate_js(js_command)
        except Exception as e:
            logger.error(f"Error sending initial data: {e}")
        
        return json.dumps({"success": True})
    
    def start_update_thread(self):
        """Start the update thread only once"""
        global _update_thread
        
        if self._thread_started:
            logger.warning("Thread already started, ignoring request")
            return
            
        logger.info("Starting update thread...")
        self.should_run = True
        self._exit_flag.clear()
        self.update_thread = threading.Thread(target=self.update_loop)
        self.update_thread.daemon = True
        self.update_thread.start()
        self._thread_started = True
        
        # Keep a global reference to prevent garbage collection
        _update_thread = self.update_thread

    def update_loop(self):
        """The main ping update loop - completely rewritten for accurate timing"""
        thread_id = threading.get_ident()
        logger.info(f"Starting update loop in thread {thread_id}...")
        
        # Initial delay to give JS time to initialize basic components
        time.sleep(0.5)
        
        ping_counter = 0
        last_log_time = time.time()
        next_ping_time = time.time()  # Initialize for first run
        
        while self.should_run and not self._exit_flag.is_set():
            try:
                current_time = time.time()
                
                # Only ping if it's time to do so
                if current_time >= next_ping_time:
                    logger.debug(f"PING TIMING: About to ping at {datetime.now().strftime('%H:%M:%S.%f')}, interval: {self.current_interval}ms")
                    
                    # Log periodically to reduce log size
                    if current_time - last_log_time > 10:
                        logger.debug(f"Thread {thread_id} still running (ping count: {ping_counter})")
                        last_log_time = current_time
                    
                    ping_counter += 1
                    
                    # Get ping data
                    ping_data = self.ping_host()
                    
                    # Update the next ping time - ensure even spacing regardless of processing time
                    next_ping_time = current_time + (self.current_interval / 1000)
                    
                    # Check if window exists before trying to use it
                    if self.window and not self._exit_flag.is_set():
                        js_command = f'if(typeof window.updateMetrics === "function") {{ window.updateMetrics({json.dumps(ping_data)}); }}'
                        try:
                            self.window.evaluate_js(js_command)
                        except Exception as e:
                            # Log and continue, don't crash the thread
                            logger.error(f"Failed to update UI: {e}")
                
                # Sleep for a short time, then check again - this allows for responsive exit
                # and for interval changes to take effect quickly
                time.sleep(0.1)
                    
            except Exception as e:
                logger.error(f"Error in update_loop: {str(e)}")
                time.sleep(1)
        
        logger.info(f"Update thread {thread_id} exiting...")

    def minimize_window(self):
        """Minimize the window"""
        self.window.minimize()
        return json.dumps({"success": True})

    def maximize_window(self):
        """Maximize the window"""
        self.window.toggle_fullscreen()
        return json.dumps({"success": True})

    def restore_window(self):
        """Restore the window from maximized state"""
        self.window.toggle_fullscreen()
        return json.dumps({"success": True})

    def close_window(self):
        """Close the window and stop all threads"""
        logger.info("Closing window and stopping threads...")
        
        # Stop thread processing
        self.should_run = False
        self._exit_flag.set()
        
        # Wait for the update thread to finish if it exists
        if self.update_thread and self.update_thread.is_alive():
            logger.info("Waiting for update thread to finish...")
            self.update_thread.join(timeout=1.0)  # Wait up to 1 second
        
        # Cleanup lock file
        remove_lock_file()
        
        logger.info("Destroying window...")
        self.window.destroy()
        return json.dumps({"success": True})

# Custom handler for locating resources
class LocalFileHandler:
    def __init__(self):
        self.base_path = get_base_path()
        logger.info(f"Static file handler base path: {self.base_path}")

    def serve(self, request):
        # Extract relative path from the URL
        path = request.path.lstrip('/')
        
        # Map it to a file in our resources directory
        if not path or path == '/':
            path = 'web/index.html'
        elif not path.startswith('web/'):
            path = f'web/{path}'
        
        full_path = os.path.join(self.base_path, path)
        logger.debug(f"Requested: {request.path}, Mapped to: {full_path}")
        
        if os.path.exists(full_path) and os.path.isfile(full_path):
            with open(full_path, 'rb') as f:
                content = f.read()
            
            content_type = self._get_content_type(full_path)
            
            return webview.http.Response(
                status=200,
                headers={'Content-Type': content_type},
                content=content
            )
        else:
            logger.error(f"File not found: {full_path}")
            return webview.http.Response(
                status=404,
                headers={'Content-Type': 'text/html'},
                content=f"<html><body><h1>404 Not Found</h1><p>The requested file {path} could not be found.</p></body></html>".encode('utf-8')
            )

    def _get_content_type(self, path):
        # Keep the content type logic the same
        extension = os.path.splitext(path)[1].lower()
        
        content_types = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
        }
        
        return content_types.get(extension, 'application/octet-stream')

# Cleanup function to ensure lock file is removed at exit
def cleanup():
    logger.info("Performing cleanup before exit")
    remove_lock_file()

# Main application code
def main():
    try:
        # Check if another instance is running
        if not check_single_instance():
            logger.warning("Another instance is already running. Exiting.")
            sys.exit(1)
        
        # Register cleanup function for normal exit
        import atexit
        atexit.register(cleanup)
        
        # Get the correct base path
        base_path = get_base_path()
        logger.info(f"Base path: {base_path}")
        
        # List files in the web directory to verify
        web_dir = os.path.join(base_path, 'web')
        logger.info(f"Web directory: {web_dir}")
        if os.path.exists(web_dir):
            logger.info("Web directory contents:")
            for item in os.listdir(web_dir):
                logger.info(f"  - {item}")
        else:
            logger.error(f"Web directory not found at {web_dir}!")
            # Create a marker file to indicate this specific error
            with open(os.path.join(log_dir, "MISSING_WEB_DIR.txt"), "w") as f:
                f.write(f"Web directory not found at: {web_dir}\n")
                f.write(f"Base path was: {base_path}\n")
            # Try to show a message box
            try:
                import ctypes
                error_msg = f"Web directory not found.\nMake sure you build with: pyinstaller --onefile --windowed --icon=web/favicon.ico --add-data \"web;web\" ping.py"
                ctypes.windll.user32.MessageBoxW(0, error_msg, "Network Monitor Error", 0)
            except:
                pass
            remove_lock_file()  # Release lock file on error
            sys.exit(1)
        
        # Convert the path to a file:// URL
        index_path = os.path.join(web_dir, 'index.html')
        
        # Verify the index file exists
        if not os.path.exists(index_path):
            logger.error(f"ERROR: Index file not found at {index_path}")
            # Create a marker file to indicate this specific error
            with open(os.path.join(log_dir, "MISSING_INDEX.txt"), "w") as f:
                f.write(f"Index file not found at: {index_path}\n")
            try:
                import ctypes
                error_msg = f"Index file not found at {index_path}"
                ctypes.windll.user32.MessageBoxW(0, error_msg, "Network Monitor Error", 0)
            except:
                pass
            remove_lock_file()  # Release lock file on error
            sys.exit(1)
        
        logger.info(f"Index file found at: {index_path}")
        
        # Convert the path to a file:// URL
        if platform.system().lower() == "windows":
            file_url = f"file:///{index_path.replace(os.sep, '/')}"
        else:
            file_url = f"file://{index_path}"
        
        logger.info(f"Loading file URL: {file_url}")
        
        # Create the window
        logger.info("Creating window...")
        window = webview.create_window(
            'Network Monitor',
            url=file_url,
            width=1050,
            height=670,
            min_size=(800, 650),
            frameless=True
        )
        
        # Create the API instance
        logger.info("Creating API instance...")
        api = API(window)
        
        # Register a clean shutdown handler
        def on_closing():
            logger.info("Application is closing...")
            api.should_run = False
            api._exit_flag.set()
            if api.update_thread and api.update_thread.is_alive():
                api.update_thread.join(timeout=1.0)
            remove_lock_file()  # Remove lock file on close
            logger.info("Threads stopped")
        
        # Expose individual methods using the window object
        logger.info("Exposing API methods...")
        window.expose(api.get_ping_data)
        window.expose(api.set_interval)
        window.expose(api.js_ready)
        
        window.expose(api.minimize_window)
        window.expose(api.maximize_window)
        window.expose(api.restore_window)
        window.expose(api.close_window)
        
        # Set the closing event handler
        window.events.closing += on_closing
        
        # Start the application
        logger.info("Starting webview application...")
        webview.start(debug=False)
        
    except Exception as e:
        logger.critical(f"Fatal error in main function: {e}", exc_info=True)
        # Write to an easy-to-find error file
        with open(os.path.join(log_dir, "FATAL_ERROR.txt"), "w") as f:
            f.write(f"Fatal error occurred: {e}\n\n")
            f.write(traceback.format_exc())
        
        # If possible, show a message box
        try:
            import ctypes
            error_msg = f"Fatal error: {str(e)}\n\nCheck log at: {log_file}"
            ctypes.windll.user32.MessageBoxW(0, error_msg, "Network Monitor Error", 0)
        except:
            pass
        
        # Remove lock file on fatal error
        remove_lock_file()
        
        sys.exit(1)

if __name__ == '__main__':
    logger.info("Script started")
    main()
    logger.info("Script exited normally")
    # Make sure lock file is removed at the end
    remove_lock_file()